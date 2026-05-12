import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";
import { produceDraftFromInbound } from "./produce-from-inbound";
import { evaluateAutoPauseCircuitBreaker } from "./circuit-breaker";

/**
 * Items 50 + 51 — continuous-background draft producer + operator
 * backfill.
 *
 * Scans `IngestedMessage` rows for un-drafted inbound and produces a
 * draft for each via `produceDraftFromInbound`. Two callers:
 *
 *   - **Cron (`auto-draft`)**: runs every 5 minutes with default
 *     bounds (24h backlog window, 25 produced per tenant per pass).
 *     Fast enough that "no inbuilt latency" is honoured in practice
 *     (worst-case ~5 min between mail arrival and draft
 *     availability), slow enough that batched LLM spend stays
 *     predictable.
 *
 *   - **Operator backfill (item 51)**: `runAutoDraftSweep` accepts
 *     a `backlogWindowHours` override so an operator can press a
 *     button on /admin/channels and replay drafting against historic
 *     inbound (e.g. "the last 30 days"). The per-tenant cap is also
 *     overridable so a deliberate backfill isn't trickled out at the
 *     cron's 25-per-tick rate. Both bounds are still clamped to
 *     conservative platform-level ceilings to defuse typo-as-disaster
 *     (a 9999-day window or 100000 cap).
 *
 * Ownership: the draft is attributed to the Membership behind the
 * most recent ACTIVE `ChannelAuth` on the channel that ingested the
 * message. Same posture as `synthesiseFromOutbound` (item 1's
 * bypassed-send detection). Without a connected User we can't assign
 * UCG version, can't notify on escalation, so we skip rather than
 * synthesise an "anonymous" draft.
 *
 * Concurrency: the `auto-draft` cron is locked by item 47's
 * advisory-lock wrapper, so two simultaneous runs don't double up.
 * The backfill route bypasses that lock (it's operator-initiated and
 * can legitimately run alongside the cron); the per-row
 * `produceDraftFromInbound` idempotency check is the safety net.
 *
 * Observability (item 52): the sweep persists one `AutoDraftSweepRun`
 * row per tenant per pass with the effective window, counts, and a
 * skip-reason histogram. Persistence is best-effort — a failed insert
 * is logged but does not poison the sweep (the cron's job is to
 * produce drafts, not write observability rows).
 */

const DEFAULT_BACKLOG_WINDOW_HOURS = 24;
const DEFAULT_MAX_PER_TENANT_PER_PASS = 25;

/// Hard ceilings — clamp regardless of caller input. One year of
/// look-back is the most an operator can plausibly want for a manual
/// review; 500 produced drafts in one batch is the most a single
/// button-press should ever issue (re-press to continue).
export const MAX_BACKLOG_WINDOW_HOURS = 365 * 24;
export const MAX_PER_TENANT_PER_PASS_CEILING = 500;
const SCAN_PAGE_SIZE_DEFAULT = 200;

/// Sweep-level skip reason codes, distinct from the
/// `produceDraftFromInbound` codes — these fire before we even call
/// the producer (no channel to attribute to, or no active ChannelAuth
/// behind the channel).
export type SweepLevelSkipCode = "no_channel_id" | "no_active_channel_auth";

export type AutoDraftSweepResult = {
  tenantsScanned: number;
  candidates: number;
  produced: number;
  skipped: number;
  errored: number;
  /// Effective `backlogWindowHours` after clamping (operator-visible).
  windowHours: number;
  /// Effective per-tenant cap after clamping.
  maxPerTenant: number;
};

export async function runAutoDraftSweep(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — on-demand triggers + tests. */
  tenantId?: string;
  /**
   * Look-back window in hours. Defaults to 24 (the cron path). The
   * operator-backfill route passes `daysBack * 24`. Clamped to
   * `[1, MAX_BACKLOG_WINDOW_HOURS]`.
   */
  backlogWindowHours?: number;
  /**
   * Maximum drafts produced per tenant in this call. Defaults to 25
   * (the cron path). The operator-backfill route passes a larger
   * value when the operator explicitly accepts the LLM cost.
   * Clamped to `[1, MAX_PER_TENANT_PER_PASS_CEILING]`.
   */
  maxPerTenant?: number;
  /**
   * Item 52 — `AutoDraftSweepRun.source` discriminator. Defaults to
   * "CRON". The operator-backfill path passes "BACKFILL" so a
   * reviewer can later distinguish auto-cron runs from
   * button-pressed catch-ups.
   */
  source?: "CRON" | "BACKFILL";
  /**
   * Item 52 — operator who triggered a BACKFILL pass. Recorded on
   * the persisted sweep-run row. Null/undefined for cron-triggered
   * passes (system-driven; no user actor).
   */
  triggeredByMembershipId?: string | null;
}): Promise<AutoDraftSweepResult> {
  const now = opts?.now ?? new Date();
  const windowHours = Math.max(
    1,
    Math.min(
      MAX_BACKLOG_WINDOW_HOURS,
      Math.trunc(opts?.backlogWindowHours ?? DEFAULT_BACKLOG_WINDOW_HOURS),
    ),
  );
  const maxPerTenant = Math.max(
    1,
    Math.min(
      MAX_PER_TENANT_PER_PASS_CEILING,
      Math.trunc(opts?.maxPerTenant ?? DEFAULT_MAX_PER_TENANT_PER_PASS),
    ),
  );
  const source = opts?.source ?? "CRON";
  const triggeredByMembershipId = opts?.triggeredByMembershipId ?? null;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  // Scan page size grows with the per-tenant cap so a 500-draft
  // backfill doesn't get truncated by a 200-row scan window.
  const scanPageSize = Math.max(SCAN_PAGE_SIZE_DEFAULT, maxPerTenant * 2);

  // Tenants in scope: ACTIVE or PROVISIONING, with at least one
  // COMMITTED FCG (drafting cannot proceed without one anyway — same
  // gate as /api/ai/draft).
  const tenants = await superDb.tenant.findMany({
    where: {
      status: { in: ["ACTIVE", "PROVISIONING"] },
      ...(opts?.tenantId ? { id: opts.tenantId } : {}),
      fcgs: { some: { status: "COMMITTED" } },
    },
    select: { id: true },
  });

  const result: AutoDraftSweepResult = {
    tenantsScanned: tenants.length,
    candidates: 0,
    produced: 0,
    skipped: 0,
    errored: 0,
    windowHours,
    maxPerTenant,
  };

  for (const t of tenants) {
    // Item 59 — circuit breaker. Evaluated once per tenant per pass
    // BEFORE iterating inbound. A trip auto-pauses the tenant + audits
    // + notifies FIRM_ADMINs, then this pass skips iteration (subsequent
    // `produceDraftFromInbound` calls would short-circuit anyway via
    // item 58's defence-in-depth gate, but skipping here avoids a per-
    // inbound DB read for nothing). The CRON source only — operator
    // backfill is an explicit human decision and shouldn't be blocked
    // by a recent failure burst.
    if (source === "CRON") {
      try {
        const breaker = await evaluateAutoPauseCircuitBreaker({
          tenantId: t.id,
          now,
        });
        if (breaker.result === "auto_paused" || breaker.result === "already_paused") {
          // Persist a sweep-run row so the operator sees a CRON pass
          // happened but produced nothing for this tenant. Skip-reasons
          // histogram stays empty; the cause is the pause state, not
          // a per-inbound skip code.
          try {
            await superDb.autoDraftSweepRun.create({
              data: {
                tenantId: t.id,
                source,
                triggeredByMembershipId,
                startedAt: now,
                windowHours,
                maxPerTenant,
                candidates: 0,
                produced: 0,
                skipped: 0,
                errored: 0,
                skipReasons: {} as Prisma.InputJsonValue,
              },
            });
          } catch (err) {
            reportError(
              err,
              {
                route: "lib/drafts/auto-sweep",
                tenantId: t.id,
                extra: { stage: "persist_sweep_run_paused", source },
              },
              "auto-draft sweep run persist failed",
            );
          }
          continue;
        }
      } catch (err) {
        reportError(
          err,
          { route: "lib/drafts/auto-sweep", tenantId: t.id },
          "auto-draft circuit breaker evaluation failed",
        );
        // Fall through to normal iteration on breaker failure — better
        // to keep producing than to block on the breaker itself.
      }
    }

    const candidates = await superDb.ingestedMessage.findMany({
      where: {
        tenantId: t.id,
        direction: "IN",
        createdAt: { gte: windowStart },
        // Negative join: only rows that have NO Draft pointing at them.
        // Prisma's `none` over the relation expresses this directly and
        // translates to a `NOT EXISTS (…)` subquery.
        drafts: { none: {} },
      },
      orderBy: { createdAt: "asc" },
      take: scanPageSize,
      select: { id: true, channelId: true },
    });

    let producedForTenant = 0;
    const perTenant = {
      candidates: 0,
      produced: 0,
      skipped: 0,
      errored: 0,
      // Histogram of reason codes (both sweep-level and producer-level).
      // Persisted verbatim on the AutoDraftSweepRun row.
      skipReasons: {} as Record<string, number>,
    };
    const bumpReason = (code: string) => {
      perTenant.skipReasons[code] = (perTenant.skipReasons[code] ?? 0) + 1;
    };

    for (const im of candidates) {
      if (producedForTenant >= maxPerTenant) break;
      result.candidates += 1;
      perTenant.candidates += 1;

      // Resolve ownership via the most recent active ChannelAuth on the
      // channel. Without a channelId we can't attribute; skip and let
      // an operator follow up (this only happens for IM rows created
      // outside the channel-ingest path, e.g. the /api/ai/draft route
      // which always attributes via the calling Membership).
      if (!im.channelId) {
        result.skipped += 1;
        perTenant.skipped += 1;
        bumpReason("no_channel_id");
        continue;
      }
      const auth = await superDb.channelAuth.findFirst({
        where: { channelId: im.channelId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: { membershipId: true },
      });
      if (!auth?.membershipId) {
        result.skipped += 1;
        perTenant.skipped += 1;
        bumpReason("no_active_channel_auth");
        continue;
      }

      try {
        const outcome = await produceDraftFromInbound({
          tenantId: t.id,
          ingestedMessageId: im.id,
          membershipId: auth.membershipId,
        });
        if (outcome.result === "produced") {
          result.produced += 1;
          perTenant.produced += 1;
          producedForTenant += 1;
        } else {
          result.skipped += 1;
          perTenant.skipped += 1;
          bumpReason(outcome.reasonCode);
        }
      } catch (err) {
        // A single LLM error / DB hiccup must not poison the whole
        // sweep. Log + count; the next cron tick retries.
        reportError(err, {
          route: "lib/drafts/auto-sweep",
          tenantId: t.id,
          extra: { ingestedMessageId: im.id, channelId: im.channelId },
        }, "auto-draft sweep produce failed");
        result.errored += 1;
        perTenant.errored += 1;
      }
    }

    // Best-effort observability persistence. The sweep's primary job
    // is to produce drafts; an insert failure here must not abort it.
    try {
      await superDb.autoDraftSweepRun.create({
        data: {
          tenantId: t.id,
          source,
          triggeredByMembershipId,
          startedAt: now,
          windowHours,
          maxPerTenant,
          candidates: perTenant.candidates,
          produced: perTenant.produced,
          skipped: perTenant.skipped,
          errored: perTenant.errored,
          skipReasons: perTenant.skipReasons as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/drafts/auto-sweep",
          tenantId: t.id,
          extra: { stage: "persist_sweep_run", source },
        },
        "auto-draft sweep run persist failed",
      );
    }
  }

  return result;
}
