import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { ValidationError } from "@/lib/api-errors";
import { runAutoDraftSweep, MAX_BACKLOG_WINDOW_HOURS, MAX_PER_TENANT_PER_PASS_CEILING } from "./auto-sweep";

/**
 * Item 51 — operator-triggered backfill of auto-drafting.
 *
 * Wraps `runAutoDraftSweep` with two operator-visible affordances:
 *   - `daysBack` (1..365): how far back to look. Distinct from the
 *     cron's 24h window. The operator chose this; we honour it.
 *   - Per-tenant cap raised to `MAX_PER_TENANT_PER_PASS_CEILING`
 *     (500). The cron's 25/tick trickle is wrong for a deliberate
 *     replay — the operator pressed a button accepting LLM cost.
 *
 * Writes an `AUTO_DRAFT_BACKFILL_TRIGGERED` audit on the operator's
 * tenant chain with the chosen window + counts, distinct from the
 * per-draft `DRAFT_PRODUCED` entries the sweep emits. A reviewer can
 * therefore answer "who pressed the button, when, what window."
 *
 * Operator UX assumption: re-press to continue. A backfill with 1200
 * candidates returns after producing 500; a second press picks up
 * the remaining 700 because `produceDraftFromInbound` is idempotent
 * on `IngestedMessage.id`.
 */

const MIN_DAYS_BACK = 1;
const MAX_DAYS_BACK = 365;

export type BackfillInput = {
  tenantId: string;
  actorMembershipId: string;
  daysBack: number;
};

export type BackfillResult = {
  daysBack: number;
  produced: number;
  skipped: number;
  errored: number;
  candidates: number;
};

export async function runAutoDraftBackfill(input: BackfillInput): Promise<BackfillResult> {
  const raw = Math.trunc(input.daysBack);
  if (!Number.isFinite(raw)) {
    throw new ValidationError("daysBack must be a number", "daysBack_invalid");
  }
  const days = Math.max(MIN_DAYS_BACK, Math.min(MAX_DAYS_BACK, raw));
  // Belt + braces: ensure the tenant actually has a COMMITTED FCG
  // before we burn the user's tenant audit chain on a no-op
  // backfill. The sweep would skip-all anyway, but the audit row
  // would mis-imply "we tried" rather than "operator cannot replay
  // without a culture guide in place."
  const fcgCount = await superDb.firmCultureGuide.count({
    where: { tenantId: input.tenantId, status: "COMMITTED" },
  });
  if (fcgCount === 0) {
    throw new ValidationError(
      "Cannot backfill drafts: tenant has no committed FCG.",
      "no_committed_fcg",
    );
  }

  const sweep = await runAutoDraftSweep({
    tenantId: input.tenantId,
    backlogWindowHours: days * 24,
    maxPerTenant: MAX_PER_TENANT_PER_PASS_CEILING,
    source: "BACKFILL",
    triggeredByMembershipId: input.actorMembershipId,
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "AUTO_DRAFT_BACKFILL_TRIGGERED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: {
      daysBack: days,
      produced: sweep.produced,
      skipped: sweep.skipped,
      errored: sweep.errored,
      candidates: sweep.candidates,
      maxPerTenantApplied: MAX_PER_TENANT_PER_PASS_CEILING,
    },
  });

  return {
    daysBack: days,
    produced: sweep.produced,
    skipped: sweep.skipped,
    errored: sweep.errored,
    candidates: sweep.candidates,
  };
}

export const BACKFILL_DAYS_BOUNDS = {
  min: MIN_DAYS_BACK,
  max: MAX_DAYS_BACK,
} as const;

void MAX_BACKLOG_WINDOW_HOURS;
