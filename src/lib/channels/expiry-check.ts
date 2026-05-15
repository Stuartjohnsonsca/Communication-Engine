import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 53 — pre-emptive channel-auth expiry warning.
 * Extended by item 110 to also handle PASSWORD-method auths.
 *
 * OAuth tokens on connected channels (Google Workspace, Microsoft 365,
 * Slack, Teams, SharePoint) expire silently if not refreshed.
 * Item 110 added a second class of auths — PASSWORD-method (IMAP) —
 * where the deadline is platform-enforced (`nextReauthAt`) rather
 * than provider-stamped (`expiresAt`).
 *
 * Both paths fire the SAME notification kind (`channel_auth_expiring`)
 * because the User-facing semantic is identical: "your connection
 * needs re-authorisation soon, click here." The thresholds differ
 * because re-entry friction differs:
 *   - **OAuth**: 7d warning, 1d urgent. Re-auth = one click on the
 *     consent screen — low friction so the warning window can be
 *     short.
 *   - **PASSWORD**: 14d warning, 3d urgent. Re-auth = look up
 *     password in a manager OR ask IT — higher friction so the
 *     warning window starts wider.
 *
 * Skip conditions (apply to both paths):
 *   - `revokedAt` is set.
 *   - `membershipId` is null.
 *   - The owning Membership is not ACTIVE.
 * OAuth-specific skips:
 *   - `expiresAt` is null OR already past.
 * PASSWORD-specific skips:
 *   - `nextReauthAt` is null OR already past (the
 *     `markPasswordAuthFailed` path handles "broken NOW"
 *     separately via `channel_auth_failed`).
 *
 * Cron-driven; no operator entry point. Run daily.
 */

export type ExpiryThreshold = "7d" | "1d" | "14d" | "3d";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type ChannelAuthExpiryCheckResult = {
  /// ChannelAuth rows inspected this pass (across all tenants).
  scanned: number;
  /// Dispatches written this pass. Idempotent — re-running the same
  /// day produces 0 (or only the rows that crossed a threshold since
  /// the last run).
  warned: number;
  /// Per-threshold counters. OAuth uses 7d/1d; PASSWORD uses 14d/3d.
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
  const oauthHorizon = new Date(now.getTime() + SEVEN_DAYS_MS);
  const oneDayBoundary = new Date(now.getTime() + ONE_DAY_MS);
  const passwordHorizon = new Date(now.getTime() + FOURTEEN_DAYS_MS);
  const threeDayBoundary = new Date(now.getTime() + THREE_DAYS_MS);

  const auths = await superDb.channelAuth.findMany({
    where: {
      revokedAt: null,
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      // Item 110 — match BOTH OAuth (expiresAt window) AND password
      // (nextReauthAt window). One Prisma query with an OR — the
      // Member-side filter that follows is identical for both paths.
      OR: [
        { authMethod: "OAUTH", expiresAt: { gt: now, lte: oauthHorizon } },
        { authMethod: "PASSWORD", nextReauthAt: { gt: now, lte: passwordHorizon } },
      ],
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
    warnedByThreshold: { "7d": 0, "1d": 0, "14d": 0, "3d": 0 },
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

      // Item 110 — branch on authMethod for the deadline source +
      // threshold ladder. OAuth uses provider-stamped `expiresAt`
      // (7d/1d), PASSWORD uses platform-set `nextReauthAt` (14d/3d).
      const isPassword = auth.authMethod === "PASSWORD";
      const deadline = isPassword ? auth.nextReauthAt! : auth.expiresAt!;
      let threshold: ExpiryThreshold;
      if (isPassword) {
        threshold = deadline <= threeDayBoundary ? "3d" : "14d";
      } else {
        threshold = deadline <= oneDayBoundary ? "1d" : "7d";
      }
      const dedupeKey = `${auth.id}:${threshold}`;
      const daysUntilExpiry = Math.max(
        0,
        Math.ceil((deadline.getTime() - now.getTime()) / ONE_DAY_MS),
      );

      const reauthCallToAction = isPassword
        ? "Open /account → your IMAP connection → re-enter your password to extend by another cycle."
        : "Open Channels → Connect to refresh.";
      const isUrgent = threshold === "1d" || threshold === "3d";
      const subject = isUrgent
        ? `Urgent: ${auth.channel.kind} channel re-authorisation due in ~${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`
        : `${auth.channel.kind} channel needs re-authorisation in ~${daysUntilExpiry} days`;
      const text = isUrgent
        ? `Your ${auth.channel.kind} channel connection requires re-authorisation by ${deadline.toISOString()}. ` +
          `Without it, ingest will stop and the engine will produce no new drafts for messages on that channel. ` +
          reauthCallToAction
        : `Heads up: your ${auth.channel.kind} channel connection needs re-authorisation by ${deadline.toISOString()} ` +
          `(~${daysUntilExpiry} days). Re-authorising now prevents an interruption. ` +
          reauthCallToAction;

      const dispatch = await dispatchNotification({
        tenantId: auth.tenantId,
        membershipId: auth.membership.id,
        toEmail: auth.membership.user.email,
        kind: "channel_auth_expiring",
        dedupeKey,
        subject,
        text,
        summary: subject,
        // Item 110 — point to /account for password (the User
        // re-enters there). OAuth path retains /admin/channels
        // because the FIRM_ADMIN-side connect button lives there
        // historically.
        href: isPassword ? `/account` : `/admin/channels`,
        payload: {
          channelAuthId: auth.id,
          channelId: auth.channelId,
          channelKind: auth.channel.kind,
          authMethod: auth.authMethod,
          threshold,
          expiresAt: deadline.toISOString(),
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
          authMethod: auth.authMethod,
          threshold,
          expiresAt: deadline.toISOString(),
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
