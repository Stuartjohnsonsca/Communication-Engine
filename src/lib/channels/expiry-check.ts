import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 53 — pre-emptive channel-auth expiry warning.
 *
 * OAuth tokens on connected channels (Google Workspace, Microsoft 365,
 * Slack) expire silently if not refreshed. When that happens the
 * ingestion path stops fetching mail; with item 52's auto-draft
 * activity card the operator sees "0 candidates" forever but has no
 * upstream breadcrumb to the expiring token. This sweep closes that
 * loop by warning the owning Membership before the token dies.
 *
 * Two thresholds, fired independently:
 *   - **7-day warning**: token expires inside (now, now+7d]. One
 *     dispatch per (ChannelAuth, "7d"); subsequent daily cron runs are
 *     no-ops because the NotificationDispatch row already exists.
 *   - **1-day urgent**: token expires inside (now, now+1d]. Same
 *     dedupe, separate key — a token that crosses both thresholds
 *     fires both warnings (7d first, then 1d when it gets close).
 *
 * Skip conditions:
 *   - `revokedAt` is set (operator already disconnected the channel).
 *   - `expiresAt` is null (some adapters don't set an explicit expiry).
 *   - `expiresAt` is already in the past (too late to warn; the
 *     refresh-failed path emits `CHANNEL_TOKEN_REFRESH_FAILED`
 *     separately, and the operator will see ingest failing in the
 *     channels table regardless).
 *   - `membershipId` is null (orphan auth; can't address the email).
 *   - The owning Membership is not ACTIVE (lifecycle-revoked /
 *     leaver-frozen / anonymised / suspended). Same gate as the
 *     drafting path — alerting a leaver about a token expiry is
 *     useless and forwarding goes to nobody.
 *
 * Cron-driven; no operator entry point. Run daily.
 *
 * Notification kind is `channel_auth_expiring` — mandatory (not in
 * `OPT_OUTABLE_KINDS`), because muting it defeats the engine's "no
 * missed emails" premise.
 */

export type ExpiryThreshold = "7d" | "1d";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type ChannelAuthExpiryCheckResult = {
  /// ChannelAuth rows inspected this pass (across all tenants).
  scanned: number;
  /// Dispatches written this pass. Idempotent — re-running the same
  /// day produces 0 (or only the rows that crossed a threshold since
  /// the last run).
  warned: number;
  /// Per-threshold counters.
  warnedByThreshold: Record<ExpiryThreshold, number>;
  /// Dispatch already existed for (channelAuth, threshold) — counted
  /// for visibility but not re-actioned.
  alreadyWarned: number;
  /// Skipped for any of the documented reasons above.
  skipped: number;
  /// Persist + dispatch threw. Logged via `reportError`; cron does not
  /// abort on a single failure.
  errored: number;
};

export async function runChannelAuthExpiryCheck(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<ChannelAuthExpiryCheckResult> {
  const now = opts?.now ?? new Date();
  const horizon = new Date(now.getTime() + SEVEN_DAYS_MS);
  const oneDayBoundary = new Date(now.getTime() + ONE_DAY_MS);

  const auths = await superDb.channelAuth.findMany({
    where: {
      revokedAt: null,
      expiresAt: { gt: now, lte: horizon },
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    include: {
      channel: { select: { id: true, kind: true, tenantId: true } },
      membership: {
        select: {
          id: true,
          status: true,
          accessRevokedAt: true,
          reauthDeadlineAt: true,
          leaverMarkedAt: true,
          anonymisedAt: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  const result: ChannelAuthExpiryCheckResult = {
    scanned: auths.length,
    warned: 0,
    warnedByThreshold: { "7d": 0, "1d": 0 },
    alreadyWarned: 0,
    skipped: 0,
    errored: 0,
  };

  for (const auth of auths) {
    try {
      if (!auth.membership || !auth.membership.user.email) {
        result.skipped += 1;
        continue;
      }
      if (auth.membership.status !== "ACTIVE") {
        result.skipped += 1;
        continue;
      }
      // Lifecycle revoked memberships hold ACTIVE status during the
      // 30-day grace window (PRD §14.3). Don't email a User whose
      // access has already been revoked — they can't act on it.
      if (auth.membership.accessRevokedAt && auth.membership.reauthDeadlineAt && now > auth.membership.reauthDeadlineAt) {
        result.skipped += 1;
        continue;
      }

      const expiresAt = auth.expiresAt!;
      const threshold: ExpiryThreshold = expiresAt <= oneDayBoundary ? "1d" : "7d";
      const dedupeKey = `${auth.id}:${threshold}`;
      const daysUntilExpiry = Math.max(
        0,
        Math.ceil((expiresAt.getTime() - now.getTime()) / ONE_DAY_MS),
      );

      const subject =
        threshold === "1d"
          ? `Urgent: ${auth.channel.kind} channel token expires in ~24 hours`
          : `${auth.channel.kind} channel token expires in ~${daysUntilExpiry} days`;
      const text =
        threshold === "1d"
          ? `Your ${auth.channel.kind} channel connection will expire on ${expiresAt.toISOString()}. ` +
            `Reconnect within 24 hours or ingest will stop and the engine will produce no new drafts ` +
            `for messages on that channel. Open Channels → Connect to refresh.`
          : `Heads up: your ${auth.channel.kind} channel connection expires on ${expiresAt.toISOString()} ` +
            `(~${daysUntilExpiry} days). Reconnecting now prevents an interruption — ingest stops the moment ` +
            `the OAuth token expires. Open Channels → Connect to refresh.`;

      const dispatch = await dispatchNotification({
        tenantId: auth.tenantId,
        membershipId: auth.membership.id,
        toEmail: auth.membership.user.email,
        kind: "channel_auth_expiring",
        dedupeKey,
        subject,
        text,
        summary: subject,
        href: `/admin/channels`,
        payload: {
          channelAuthId: auth.id,
          channelId: auth.channelId,
          channelKind: auth.channel.kind,
          threshold,
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry,
        },
      });

      if (dispatch.alreadySent) {
        result.alreadyWarned += 1;
        continue;
      }

      result.warned += 1;
      result.warnedByThreshold[threshold] += 1;

      // Audit on the tenant's chain. The dispatch itself wrote
      // NOTIFICATION_DISPATCHED, but a dedicated event makes the
      // "token nearly expired" story queryable without joining
      // through the dispatch payload.
      await writeAuditEvent({
        tenantId: auth.tenantId,
        eventType: "CHANNEL_AUTH_EXPIRY_WARNED",
        actorMembershipId: null,
        subjectType: "ChannelAuth",
        subjectId: auth.id,
        payload: {
          channelId: auth.channelId,
          channelKind: auth.channel.kind,
          membershipId: auth.membership.id,
          threshold,
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry,
          dispatchId: dispatch.dispatchId ?? null,
        },
      });
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/channels/expiry-check",
          tenantId: auth.tenantId,
          extra: { channelAuthId: auth.id, channelId: auth.channelId },
        },
        "channel-auth expiry warning dispatch failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
