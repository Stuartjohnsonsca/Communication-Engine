import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { ValidationError } from "@/lib/api-errors";
import type { NotificationKind } from "./dispatch";

/**
 * Post-PRD hardening item 45 — per-User email preferences for the kinds
 * a User may mute.
 *
 * Two-tier policy:
 *
 *   • **Opt-outable** kinds (this list) may be muted via /<slug>/account.
 *     The in-app inbox row still appears; only the SMTP send is skipped.
 *
 *   • **Mandatory** kinds (everything not in this list) always send.
 *     Reasons:
 *       - `breach_ack_required` / `subprocessor_change_*` /
 *         `audit_chain_tampered` — DPA / DPA-art-28 obligations.
 *       - `sentiment_escalation` / `adherence_escalation` — firm
 *         governance signal; the email is the audit-grade record.
 *       - `cron_stalled` — operator alert; missing it defeats the cron.
 *       - `totp_reset_by_admin` — security advisory.
 *
 * `setEmailEnabled` refuses non-opt-outable kinds with ValidationError,
 * and the dispatcher's `isOptOutable` check is a second gate — a row
 * inserted directly into the DB for a mandatory kind is silently
 * ignored. Defence in depth.
 *
 * The lookup is small: at most one row per (membership, kind), and
 * dispatch only queries when the kind is opt-outable. We don't cache;
 * `dispatchNotification` is not on a hot tight loop.
 */

export const OPT_OUTABLE_KINDS = ["weekly_digest", "sign_in_new_device"] as const;
export type OptOutableKind = (typeof OPT_OUTABLE_KINDS)[number];

export function isOptOutable(kind: string): kind is OptOutableKind {
  return (OPT_OUTABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Returns whether email is enabled for (membershipId, kind). Mandatory
 * kinds always return true regardless of any stored row — callers
 * should typically gate this lookup behind `isOptOutable`, but this
 * function is safe to call unconditionally.
 */
export async function getEmailEnabled(
  membershipId: string,
  kind: NotificationKind,
): Promise<boolean> {
  if (!isOptOutable(kind)) return true;
  const row = await superDb.membershipNotificationPreference.findUnique({
    where: { membershipId_kind: { membershipId, kind } },
    select: { emailEnabled: true },
  });
  return row?.emailEnabled ?? true;
}

/** Map every opt-outable kind → current emailEnabled (default true). */
export async function listPreferences(
  membershipId: string,
): Promise<Record<OptOutableKind, boolean>> {
  const rows = await superDb.membershipNotificationPreference.findMany({
    where: {
      membershipId,
      kind: { in: OPT_OUTABLE_KINDS as readonly string[] as string[] },
    },
    select: { kind: true, emailEnabled: true },
  });
  const map = Object.fromEntries(
    OPT_OUTABLE_KINDS.map((k) => [k, true] as const),
  ) as Record<OptOutableKind, boolean>;
  for (const r of rows) {
    if (isOptOutable(r.kind)) map[r.kind] = r.emailEnabled;
  }
  return map;
}

/**
 * Set the preference for an opt-outable kind. Throws ValidationError
 * for non-opt-outable kinds — the caller is expected to keep the UI in
 * sync with `OPT_OUTABLE_KINDS`. Writes a
 * `NOTIFICATION_PREFERENCE_CHANGED` audit event with the prior + new
 * value so the chain shows the diff.
 */
export async function setEmailEnabled(args: {
  tenantId: string;
  membershipId: string;
  actorMembershipId: string;
  kind: string;
  emailEnabled: boolean;
}): Promise<void> {
  if (!isOptOutable(args.kind)) {
    throw new ValidationError(
      `Notification kind "${args.kind}" is mandatory and cannot be muted.`,
      "notification_kind_mandatory",
    );
  }

  const prior = await superDb.membershipNotificationPreference.findUnique({
    where: { membershipId_kind: { membershipId: args.membershipId, kind: args.kind } },
    select: { id: true, emailEnabled: true },
  });

  const row = await superDb.membershipNotificationPreference.upsert({
    where: {
      membershipId_kind: { membershipId: args.membershipId, kind: args.kind },
    },
    create: {
      tenantId: args.tenantId,
      membershipId: args.membershipId,
      kind: args.kind,
      emailEnabled: args.emailEnabled,
    },
    update: {
      emailEnabled: args.emailEnabled,
    },
  });

  // Only audit on a real transition — flipping the toggle to its current
  // value should not pollute the chain with no-op entries.
  const priorValue = prior?.emailEnabled ?? true;
  if (priorValue === args.emailEnabled) return;

  await writeAuditEvent({
    tenantId: args.tenantId,
    eventType: "NOTIFICATION_PREFERENCE_CHANGED",
    actorMembershipId: args.actorMembershipId,
    subjectType: "MembershipNotificationPreference",
    subjectId: row.id,
    payload: {
      membershipId: args.membershipId,
      kind: args.kind,
      emailEnabled: args.emailEnabled,
      prior: priorValue,
    },
  });
}
