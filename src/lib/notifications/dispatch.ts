import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { isMailerConfigured, sendNotificationEmail } from "./mailer";

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
  | "adherence_escalation";

export type DispatchResult = {
  alreadySent: boolean;
  status: "DISPATCHED" | "FAILED" | "SKIPPED_NO_EMAIL_SERVER";
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

  const sendResult = input.toEmail
    ? await sendNotificationEmail({
        to: input.toEmail,
        subject: input.subject,
        text: input.text,
      })
    : { status: "SKIPPED_NO_EMAIL_SERVER" as const };

  const status =
    sendResult.status === "DISPATCHED"
      ? "DISPATCHED"
      : sendResult.status === "FAILED"
        ? "FAILED"
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
      status === "DISPATCHED" || status === "SKIPPED_NO_EMAIL_SERVER"
        ? "NOTIFICATION_DISPATCHED"
        : "NOTIFICATION_DISPATCH_FAILED",
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
