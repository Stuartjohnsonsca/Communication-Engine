import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications";
import { reportError } from "@/lib/observability";

/**
 * Admin-initiated TOTP reset. Post-PRD hardening item 19 — the
 * operational recovery path for a Member who has lost their TOTP
 * device AND every recovery code. Without this primitive the only
 * remedy is revoking the Member's whole membership (losing their
 * UCG + history), which is wildly disproportionate.
 *
 * Mechanism: clear `UserTotp.verifiedAt` + `recoveryCodesHashed`
 * and stamp `disabledAt = now()`. The TOTP gate (`evaluateTotpGate`)
 * treats this state as no-enrollment — the affected User's next
 * tenant-page load redirects them to /account to re-enroll if the
 * tenant's `requireTotp` policy is true; otherwise they continue
 * without 2FA until they choose to re-enroll voluntarily.
 *
 * The row is NOT deleted — preserving it gives a forensic trail of
 * "this User had TOTP from X, reset by Y on Z, re-enrolled on W".
 * Re-enrollment overwrites the same row via the existing
 * `initiateEnrollment` path (upsert) so we don't accumulate stale
 * rows.
 *
 * Notification: best-effort email + in-app inbox row to the affected
 * User so they know their 2FA was reset by an admin and didn't
 * spontaneously break. Dedupe key is the audit-row id so a duplicate
 * form submission (refresh during the redirect, etc.) doesn't spam
 * the affected User. The notification dispatch is fire-and-forget
 * under `reportError` — a transient mailer/inbox failure must NOT
 * prevent the reset itself from completing (audit + DB mutation
 * already happened).
 *
 * Authorisation: this lib does NOT check RBAC — the caller does. The
 * standard call site is `/admin/security`, which checks
 * `tenant:reset-member-totp` and applies a step-up gate (item 18)
 * before calling here. Cross-tenant safety: we verify the target
 * User has an ACTIVE membership in the tenant before touching their
 * UserTotp row, so a FIRM_ADMIN of tenant A cannot reset the TOTP
 * of a User who is only a member of tenant B.
 */

export type ResetResult =
  | { ok: true; alreadyReset: boolean; auditEventId: string }
  | { ok: false; reason: "no-membership" | "no-enrollment" };

export async function resetTotpForUser(opts: {
  tenantId: string;
  /** The User whose TOTP is being reset. */
  targetUserId: string;
  /** The Firm Administrator initiating the reset. */
  actorMembershipId: string;
}): Promise<ResetResult> {
  // Cross-tenant safety: refuse to reset a TOTP for a User who has no
  // ACTIVE membership in this tenant. Without this guard a FIRM_ADMIN
  // of tenant A could click a hand-crafted form to reset the TOTP of
  // a User whose only membership is in tenant B.
  const membership = await superDb.membership.findFirst({
    where: { tenantId: opts.tenantId, userId: opts.targetUserId, status: "ACTIVE" },
    select: { id: true, userId: true },
  });
  if (!membership) return { ok: false, reason: "no-membership" };

  const targetUser = await superDb.user.findUnique({
    where: { id: opts.targetUserId },
    select: { id: true, email: true, name: true },
  });
  if (!targetUser) return { ok: false, reason: "no-membership" };

  const totp = await superDb.userTotp.findUnique({
    where: { userId: opts.targetUserId },
    select: { id: true, verifiedAt: true, disabledAt: true },
  });

  // If the User has no enrollment at all, the "reset" is a no-op.
  // Surface that to the caller so the UI can render a friendly note
  // ("nothing to reset — this User hasn't enrolled 2FA"). We still do
  // NOT audit no-ops — a chain-padding audit row for a not-applicable
  // operation isn't useful.
  if (!totp) return { ok: false, reason: "no-enrollment" };

  const wasEffectivelyActive = !!totp.verifiedAt && !totp.disabledAt;

  // Wipe in place: preserve the row (forensic trail) but zero the
  // verification state so the gate treats it as not-enrolled. Clear
  // recovery codes so the User can't accidentally re-use one against
  // a future re-enrollment.
  if (wasEffectivelyActive) {
    await superDb.userTotp.update({
      where: { userId: opts.targetUserId },
      data: {
        verifiedAt: null,
        disabledAt: new Date(),
        recoveryCodesHashed: [],
        lastUsedAt: null,
      },
    });
  }

  const audit = await writeAuditEvent({
    tenantId: opts.tenantId,
    eventType: "TOTP_RESET_BY_ADMIN",
    actorMembershipId: opts.actorMembershipId,
    subjectType: "User",
    subjectId: opts.targetUserId,
    payload: {
      targetUserId: opts.targetUserId,
      targetUserEmail: targetUser.email,
      wasEnrolled: wasEffectivelyActive,
    },
  });

  // Best-effort notification — fire-and-forget under reportError so a
  // mailer/inbox transient failure can't roll back the reset itself.
  try {
    await dispatchNotification({
      tenantId: opts.tenantId,
      membershipId: membership.id,
      toEmail: targetUser.email,
      kind: "totp_reset_by_admin",
      // Dedupe on the audit row id so a duplicate form submit doesn't
      // double-send to the User. (writeAuditEvent allocates monotonic
      // ids — different reset events get different ids.)
      dedupeKey: audit.id,
      subject: "Your two-factor authentication has been reset",
      summary: "An administrator reset your 2FA. Re-enroll from /account on next sign-in.",
      text:
        `Your two-factor authentication for this Acumon Communications tenant has been reset ` +
        `by an administrator. On your next sign-in you will be prompted to enroll a new TOTP ` +
        `authenticator and generate fresh recovery codes.\n\n` +
        `If you did NOT request this reset and do not recognise it, contact your Firm ` +
        `Administrator immediately — the action is recorded on the tenant's audit chain.\n`,
      href: "/account",
      payload: { auditEventId: audit.id },
    });
  } catch (err) {
    reportError(err, {
      route: "totp/admin-reset/notify",
      tenantId: opts.tenantId,
      membershipId: opts.actorMembershipId,
    });
  }

  return {
    ok: true,
    alreadyReset: !wasEffectivelyActive,
    auditEventId: audit.id,
  };
}
