import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { isMailerConfigured, sendNotificationEmail } from "./mailer";
import { getEmailEnabled, isOptOutable } from "./preferences";

/**
 * Single dispatch entry-point used by both immediate triggers and the
 * weekly digest. Idempotent on (membershipId, kind, dedupeKey): if the
 * dispatch row already exists the call is a no-op and returns
 * `alreadySent: true`.
 *
 * Always writes the inbox row + the dispatch log even if the email itself
 * was skipped (no SMTP configured) so the in-app inbox + audit trail
 * reflect the event regardless of mail-channel state.
 */

export type DispatchInput = {
  tenantId: string;
  membershipId: string;
  /// Recipient email address; resolved by the caller from the membership/user.
  toEmail: string;
  /// Stable kind label — see `NotificationKind`.
  kind: NotificationKind;
  /// Idempotency key. Weekly digest = ISO week ("2026-W19"); immediate
  /// triggers = source row id.
  dedupeKey: string;
  subject: string;
  /// Plain-text body — also rendered into HTML by the mailer.
  text: string;
  /// One-line summary for the in-app inbox card.
  summary?: string;
  /// In-tenant route to the source artefact ("/<slug>/sentiment" etc.).
  href?: string;
  /// Optional structured payload appended to the audit event for traceability.
  payload?: Prisma.InputJsonValue;
};

export type NotificationKind =
  | "weekly_digest"
  | "sentiment_escalation"
  | "breach_ack_required"
  | "adherence_escalation"
  | "totp_reset_by_admin"
  | "sign_in_new_device"
  | "cron_stalled"
  | "audit_chain_tampered"
  | "subprocessor_change_announced"
  | "subprocessor_change_cancelled"
  | "subprocessor_change_effective"
  /// Post-PRD item 53 — mandatory operational alert. An OAuth token on
  /// an ACTIVE ChannelAuth is within 7 days (or 1 day) of expiry; the
  /// owning Membership needs to reconnect before ingest silently
  /// stops. Not opt-outable: a muted warning here defeats the engine's
  /// "no missed emails" premise.
  | "channel_auth_expiring"
  /// Post-PRD item 54 — mandatory operational alert. A Draft's
  /// `fcgWindowDeadline` has passed without send/discard; the FCG
  /// promised "respond within N hours" and the engine is now
  /// silently in breach of that promise. Not opt-outable: the FCG
  /// commitment is the engine's central value prop.
  | "draft_stale"
  /// Post-PRD item 59 — mandatory operational alert. The auto-draft
  /// circuit breaker tripped (N failed LLM calls in M minutes) and
  /// auto-paused the tenant. Surface to every FIRM_ADMIN so a
  /// human can investigate before resuming. Not opt-outable: muting
  /// this would mean the engine could silently stop drafting for
  /// hours without anyone noticing.
  | "auto_draft_auto_paused"
  /// Post-PRD item 61 — mandatory operational alert. The auto-draft
  /// circuit breaker auto-resumed after the failure window cleared.
  /// Surface to every FIRM_ADMIN so they know the engine is back
  /// online and don't go investigating a "stuck" pause. Not
  /// opt-outable: pairs with `auto_draft_auto_paused` — muting one
  /// side leaves operators with an incomplete picture.
  | "auto_draft_auto_resumed"
  /// Post-PRD item 63 — mandatory operational alert. A single
  /// IngestedMessage failed `QUARANTINE_THRESHOLD` consecutive
  /// draft attempts and has been removed from the sweep candidate
  /// pool. Push-notify FIRM_ADMINs so they can investigate before
  /// a backlog accumulates — without this, operators only find
  /// quarantined inbound by visiting /admin/channels. Not
  /// opt-outable: quarantine means "we tried three times and gave
  /// up," which is a real customer-facing service gap. dedupeKey
  /// uses the IngestedMessage id so each broken inbound fires at
  /// most once (re-quarantine after operator unquarantine
  /// deliberately does NOT re-fire — the operator already knew
  /// about the row).
  | "inbound_draft_quarantined"
  /// Post-PRD item 71 — mandatory governance escalation. The daily
  /// adherence-monitor cron found this tenant's 7-day FCG-window
  /// adherence below `ADHERENCE_THRESHOLD` with at least
  /// `MIN_DEADLINED_SENDS` deadlined sends in the window (the
  /// volume floor exists so a fresh tenant with 2 lucky/unlucky
  /// sends doesn't trip the alert). Fans out to every active
  /// FIRM_ADMIN. Not opt-outable: the FCG response window is the
  /// engine's central client-facing promise; muting a "we're
  /// breaking it" alert defeats governance. dedupeKey is the ISO
  /// week so a chronically-poor tenant gets one alert per week,
  /// not one per cron tick.
  | "firm_adherence_below_threshold"
  /// Post-PRD item 77 — mandatory governance nudge. A PRD §9.3
  /// sentiment escalation has been left unacknowledged for
  /// `STALE_THRESHOLD_HOURS`. Fans out to the same audience the
  /// original escalation reached (assigned User + FCT_MEMBER +
  /// FIRM_ADMIN). Not opt-outable: the unacked complaint IS the
  /// thing this notification exists to surface, and the original
  /// `sentiment_escalation` is also mandatory — muting the nudge
  /// would let extreme-negative counterparty signals sit
  /// indefinitely. dedupeKey is the SentimentSignal id so each
  /// unacked escalation fires the nudge exactly once.
  | "sentiment_escalation_stale";

export type DispatchResult = {
  alreadySent: boolean;
  status:
    | "DISPATCHED"
    | "FAILED"
    | "SKIPPED_NO_EMAIL_SERVER"
    | "SKIPPED_USER_PREFERENCE";
  errorMessage?: string;
  dispatchId?: string;
  inboxId?: string;
};

export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  // Idempotency probe: an existing row means this (membership, kind, dedupeKey)
  // already fired. Don't re-send, don't re-write inbox, don't re-audit.
  const existing = await superDb.notificationDispatch.findUnique({
    where: {
      membershipId_kind_dedupeKey: {
        membershipId: input.membershipId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
      },
    },
  });
  if (existing) {
    return {
      alreadySent: true,
      status: existing.status as DispatchResult["status"],
      errorMessage: existing.errorMessage ?? undefined,
      dispatchId: existing.id,
    };
  }

  // Post-PRD item 45 — opt-outable kinds (weekly_digest,
  // sign_in_new_device) honour the User's email-mute preference. The
  // in-app inbox row is still written so the User can find the
  // notification in their inbox; only the SMTP send is skipped.
  // Mandatory kinds (breach, audit-chain, subprocessor, escalations,
  // cron-stalled, totp-reset) short-circuit `isOptOutable` and always
  // send.
  const optedOut =
    isOptOutable(input.kind) && !(await getEmailEnabled(input.membershipId, input.kind));

  const sendResult = optedOut
    ? { status: "SKIPPED_USER_PREFERENCE" as const }
    : input.toEmail
      ? await sendNotificationEmail({
          to: input.toEmail,
          subject: input.subject,
          text: input.text,
        })
      : { status: "SKIPPED_NO_EMAIL_SERVER" as const };

  const status: DispatchResult["status"] =
    sendResult.status === "DISPATCHED"
      ? "DISPATCHED"
      : sendResult.status === "FAILED"
        ? "FAILED"
        : sendResult.status === "SKIPPED_USER_PREFERENCE"
          ? "SKIPPED_USER_PREFERENCE"
          : "SKIPPED_NO_EMAIL_SERVER";

  const errorMessage =
    sendResult.status === "FAILED" ? sendResult.errorMessage : undefined;

  // Wrap the writes in a transaction so we can't end up with a dispatch
  // row but no inbox row (or vice versa) on a transient DB error.
  const result = await superDb.$transaction(async (tx) => {
    const dispatch = await tx.notificationDispatch.create({
      data: {
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        subject: input.subject,
        status,
        errorMessage: errorMessage ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
    const inbox = await tx.notificationInbox.upsert({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: input.membershipId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        },
      },
      create: {
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        title: input.subject,
        summary: input.summary ?? null,
        body: input.text,
        href: input.href ?? null,
        emailSentAt: status === "DISPATCHED" ? new Date() : null,
      },
      update: {
        // Should not happen in steady state because the dispatch row would
        // have short-circuited above. The upsert is defence in depth.
        emailSentAt: status === "DISPATCHED" ? new Date() : null,
      },
    });
    return { dispatchId: dispatch.id, inboxId: inbox.id };
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType:
      status === "FAILED"
        ? "NOTIFICATION_DISPATCH_FAILED"
        : "NOTIFICATION_DISPATCHED",
    actorMembershipId: null,
    subjectType: "NotificationDispatch",
    subjectId: result.dispatchId,
    payload: {
      membershipId: input.membershipId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      status,
      mailerConfigured: isMailerConfigured(),
      ...(errorMessage ? { errorMessage } : {}),
    },
  });

  return {
    alreadySent: false,
    status,
    errorMessage,
    dispatchId: result.dispatchId,
    inboxId: result.inboxId,
  };
}
