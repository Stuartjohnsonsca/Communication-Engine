import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { dispatchNotification } from "./dispatch";

/**
 * Immediate-dispatch helpers for the three event classes that the backlog
 * called out as too time-sensitive for the weekly digest. Each helper:
 *   - Resolves the routing audience (assignee + FCT, or FIRM_ADMINs).
 *   - Sends one email per recipient, idempotent on the source row id.
 *   - Returns when every dispatch has been written (success or skipped).
 *
 * Every helper is fire-and-forget from the trigger's perspective: failures
 * are logged via the dispatch audit event but don't bubble up to the
 * trigger's transaction. The send-side compliance gate, the breach inbox,
 * and the sentiment classifier already wrote their primary rows + audit
 * events before we get here — notifications are a downstream side effect.
 */

type Recipient = {
  membershipId: string;
  toEmail: string;
  /// Includes "self" when the recipient is the action owner (User), or
  /// "fct" when they're routed via FCT/FIRM_ADMIN governance visibility.
  reason: "self" | "fct" | "firm_admin";
};

async function fctAndAdminRecipients(
  tenantId: string,
  excludeMembershipIds: string[] = [],
): Promise<Recipient[]> {
  // FCT_MEMBER + FIRM_ADMIN both see escalations firm-wide via members:read.
  const rows = await superDb.membership.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      role: { in: ["FCT_MEMBER", "FIRM_ADMIN"] },
      id: { notIn: excludeMembershipIds },
    },
    include: { user: { select: { email: true } } },
  });
  return rows
    .filter((r) => !!r.user.email)
    .map((r) => ({
      membershipId: r.id,
      toEmail: r.user.email!,
      reason: "fct" as const,
    }));
}

async function firmAdminRecipients(tenantId: string): Promise<Recipient[]> {
  const rows = await superDb.membership.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      role: "FIRM_ADMIN",
    },
    include: { user: { select: { email: true } } },
  });
  return rows
    .filter((r) => !!r.user.email)
    .map((r) => ({
      membershipId: r.id,
      toEmail: r.user.email!,
      reason: "firm_admin" as const,
    }));
}

async function selfRecipient(
  tenantId: string,
  membershipId: string,
): Promise<Recipient | null> {
  const m = await superDb.membership.findFirst({
    where: { id: membershipId, tenantId, status: "ACTIVE" },
    include: { user: { select: { email: true } } },
  });
  if (!m || !m.user.email) return null;
  // Validate the role still has adherence:acknowledge — anonymised /
  // suspended memberships shouldn't receive operational mail.
  if (!hasPermission(m.role, "adherence:read")) return null;
  return { membershipId: m.id, toEmail: m.user.email, reason: "self" };
}

// ─── Sentiment escalation (PRD §9.3) ──────────────────────────────────────

export async function dispatchSentimentEscalation(input: {
  tenantId: string;
  tenantSlug: string;
  signalId: string;
  assignedToMembershipId: string | null;
  /// Short summary of the inbound that triggered the signal. Already in the
  /// signal row; passed in to avoid an extra query.
  trigger?: string | null;
  inboundSender?: string | null;
}): Promise<{ recipients: number }> {
  const recipients: Recipient[] = [];
  const exclude: string[] = [];
  if (input.assignedToMembershipId) {
    const self = await selfRecipient(input.tenantId, input.assignedToMembershipId);
    if (self) {
      recipients.push(self);
      exclude.push(self.membershipId);
    }
  }
  recipients.push(...(await fctAndAdminRecipients(input.tenantId, exclude)));

  const subject = `Sentiment escalation · negative against firm handling`;
  const summary = input.inboundSender
    ? `From ${input.inboundSender}${input.trigger ? ` — ${input.trigger}` : ""}`
    : input.trigger ?? "Inbound flagged extreme-negative against firm handling.";
  const body = [
    `An inbound communication has been classified as extreme-negative against firm handling and escalated.`,
    "",
    input.trigger ? `Trigger: ${input.trigger}` : null,
    input.inboundSender ? `From: ${input.inboundSender}` : null,
    "",
    `Acknowledge it on /${input.tenantSlug}/sentiment.`,
  ]
    .filter(Boolean)
    .join("\n");
  const href = `/${input.tenantSlug}/sentiment`;

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "sentiment_escalation",
      dedupeKey: input.signalId,
      subject,
      summary,
      text: body,
      href,
      payload: {
        signalId: input.signalId,
        recipientReason: r.reason,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Sentiment escalation stale (post-PRD backlog item 77) ────────────────

export async function dispatchSentimentEscalationStale(input: {
  tenantId: string;
  tenantSlug: string;
  signalId: string;
  assignedToMembershipId: string | null;
  hoursSinceEscalation: number;
  trigger?: string | null;
  inboundSender?: string | null;
}): Promise<{ recipients: number }> {
  // Same audience as the original escalation (assigned User + FCT +
  // FIRM_ADMIN). The original `sentiment_escalation` fires at signal
  // creation; this is the second-chance nudge once `STALE_THRESHOLD_HOURS`
  // have passed without acknowledgement.
  const recipients: Recipient[] = [];
  const exclude: string[] = [];
  if (input.assignedToMembershipId) {
    const self = await selfRecipient(input.tenantId, input.assignedToMembershipId);
    if (self) {
      recipients.push(self);
      exclude.push(self.membershipId);
    }
  }
  recipients.push(...(await fctAndAdminRecipients(input.tenantId, exclude)));

  const hours = Math.max(1, Math.round(input.hoursSinceEscalation));
  const subject = `Unacknowledged sentiment escalation · ${hours}h`;
  const summary = input.inboundSender
    ? `From ${input.inboundSender}${input.trigger ? ` — ${input.trigger}` : ""}`
    : (input.trigger ?? "Escalated sentiment signal awaiting acknowledgement.");
  const body = [
    `A sentiment escalation has been outstanding for ${hours} hours without acknowledgement.`,
    "",
    input.trigger ? `Trigger: ${input.trigger}` : null,
    input.inboundSender ? `From: ${input.inboundSender}` : null,
    "",
    `Acknowledge it on /${input.tenantSlug}/sentiment so the firm has a documented response to the complaint.`,
  ]
    .filter(Boolean)
    .join("\n");
  const href = `/${input.tenantSlug}/sentiment`;

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "sentiment_escalation_stale",
      // dedupeKey == signalId. Dispatch dedupe is keyed on
      // (membershipId, kind, dedupeKey), so reusing the signal id is
      // safe across kinds — the original `sentiment_escalation` row
      // (kind=sentiment_escalation, dedupeKey=signalId) and this nudge
      // (kind=sentiment_escalation_stale, dedupeKey=signalId) occupy
      // distinct slots. One stale nudge per (membership, signal) ever.
      dedupeKey: input.signalId,
      subject,
      summary,
      text: body,
      href,
      payload: {
        signalId: input.signalId,
        hoursSinceEscalation: hours,
        recipientReason: r.reason,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Adherence escalation (post-PRD backlog item 1) ───────────────────────

export async function dispatchAdherenceEscalation(input: {
  tenantId: string;
  tenantSlug: string;
  adherenceId: string;
  draftId: string;
  membershipId: string;
  overall: number;
  threshold: number;
}): Promise<{ recipients: number }> {
  const recipients: Recipient[] = [];
  const self = await selfRecipient(input.tenantId, input.membershipId);
  const exclude: string[] = [];
  if (self) {
    recipients.push(self);
    exclude.push(self.membershipId);
  }
  recipients.push(...(await fctAndAdminRecipients(input.tenantId, exclude)));

  const overallPct = Math.round(input.overall * 100);
  const subject = `Adherence escalation · ${overallPct}% on a recent send`;
  const summary = `One of your sends scored ${overallPct}% against FCG / UCG (threshold ${Math.round(input.threshold * 100)}%).`;
  const body = [
    `A communication you sent has been scored against the FCG / UCG that were in force at the time and is below the escalation threshold.`,
    "",
    `Overall: ${overallPct}%`,
    `Threshold: ${Math.round(input.threshold * 100)}%`,
    "",
    `Open the escalation to acknowledge: /${input.tenantSlug}/adherence/escalations`,
    `View the sent draft: /${input.tenantSlug}/drafts/${input.draftId}`,
  ].join("\n");

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "adherence_escalation",
      dedupeKey: input.adherenceId,
      subject,
      summary,
      text: body,
      href: `/${input.tenantSlug}/adherence/escalations`,
      payload: {
        adherenceId: input.adherenceId,
        draftId: input.draftId,
        overall: input.overall,
        threshold: input.threshold,
        recipientReason: r.reason,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Adherence escalation stale (post-PRD backlog item 99) ────────────────

export async function dispatchAdherenceEscalationStale(input: {
  tenantId: string;
  tenantSlug: string;
  adherenceId: string;
  draftId: string;
  /// Sender of the below-threshold send — same field used by the original
  /// `dispatchAdherenceEscalation` to seed the self-recipient. Sentiment's
  /// equivalent uses `assignedToMembershipId` (assignee), but adherence
  /// escalates the sender directly: same routing as the original mandatory
  /// `adherence_escalation` so the second-chance nudge reaches the same
  /// inbox without surprise.
  membershipId: string;
  hoursSinceEscalation: number;
  overall: number;
}): Promise<{ recipients: number }> {
  // Same audience as the original escalation (sender + FCT + FIRM_ADMIN).
  // Mirrors item 77's sibling-helper pattern: the original
  // `adherence_escalation` fires at threshold trip; this is the
  // second-chance nudge once `STALE_THRESHOLD_HOURS` have passed without
  // acknowledgement.
  const recipients: Recipient[] = [];
  const exclude: string[] = [];
  const self = await selfRecipient(input.tenantId, input.membershipId);
  if (self) {
    recipients.push(self);
    exclude.push(self.membershipId);
  }
  recipients.push(...(await fctAndAdminRecipients(input.tenantId, exclude)));

  const hours = Math.max(1, Math.round(input.hoursSinceEscalation));
  const overallPct = Math.round(input.overall * 100);
  const subject = `Unacknowledged adherence escalation · ${hours}h`;
  const summary = `A below-threshold send (${overallPct}%) has been awaiting acknowledgement for ${hours}h.`;
  const body = [
    `An adherence escalation has been outstanding for ${hours} hours without acknowledgement.`,
    "",
    `Overall: ${overallPct}%`,
    "",
    `Open the escalation to acknowledge: /${input.tenantSlug}/adherence/escalations`,
    `View the sent draft: /${input.tenantSlug}/drafts/${input.draftId}`,
    "",
    `Closing the loop documents the firm's response and clears the unacked governance flag.`,
  ].join("\n");
  const href = `/${input.tenantSlug}/adherence/escalations`;

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "adherence_escalation_stale",
      // dedupeKey == adherenceId. Dispatch dedupe is keyed on
      // (membershipId, kind, dedupeKey), so reusing the row id is safe
      // across kinds — the original `adherence_escalation` row
      // (kind=adherence_escalation, dedupeKey=adherenceId) and this
      // nudge (kind=adherence_escalation_stale, dedupeKey=adherenceId)
      // occupy distinct slots. One stale nudge per (membership,
      // adherence row) ever.
      dedupeKey: input.adherenceId,
      subject,
      summary,
      text: body,
      href,
      payload: {
        adherenceId: input.adherenceId,
        draftId: input.draftId,
        hoursSinceEscalation: hours,
        overall: input.overall,
        recipientReason: r.reason,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Breach acknowledgement awaited (PRD §12.9) ───────────────────────────

export async function dispatchBreachAckRequired(input: {
  tenantId: string;
  tenantSlug: string;
  notificationId: string;
  incidentCode: string;
  incidentTitle: string;
  dueAt: Date;
}): Promise<{ recipients: number }> {
  const recipients = await firmAdminRecipients(input.tenantId);

  const subject = `Breach notification · ${input.incidentCode} requires acknowledgement`;
  const summary = `${input.incidentTitle} — acknowledge by ${input.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  const body = [
    `Acumon has dispatched a personal-data breach notification to your tenant under PRD §12.9. The DPA requires Firm Administrator acknowledgement of receipt.`,
    "",
    `Incident: ${input.incidentCode} — ${input.incidentTitle}`,
    `Acknowledge by: ${input.dueAt.toISOString()}`,
    "",
    `Acknowledge on /${input.tenantSlug}/compliance/breaches.`,
  ].join("\n");
  const href = `/${input.tenantSlug}/compliance/breaches`;

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "breach_ack_required",
      dedupeKey: input.notificationId,
      subject,
      summary,
      text: body,
      href,
      payload: {
        notificationId: input.notificationId,
        incidentCode: input.incidentCode,
        recipientReason: r.reason,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Sign-in anomaly: new device alert (post-PRD hardening item 21) ───────

export async function dispatchSignInNewDevice(input: {
  tenantId: string;
  membershipId: string;
  toEmail: string;
  sessionId: string;
  deviceLabel: string;
  ipMasked: string;
  reasons: Array<"new-browser-os" | "new-ip-block">;
}): Promise<{ recipients: number }> {
  const reasonText =
    input.reasons.includes("new-browser-os") && input.reasons.includes("new-ip-block")
      ? "new device and new network"
      : input.reasons.includes("new-browser-os")
        ? "new device"
        : "new network";
  const subject = `New sign-in detected (${reasonText})`;
  const summary = `${input.deviceLabel} from ${input.ipMasked}`;
  const body = [
    `A sign-in to your Acumon account was just detected from a ${reasonText}.`,
    "",
    `Device: ${input.deviceLabel}`,
    `IP: ${input.ipMasked}`,
    "",
    `If this was you, no action is needed.`,
    `If this WASN'T you, sign in and revoke the session immediately from /account,`,
    `then contact your Firm Administrator. The detection is recorded on the audit chain.`,
  ].join("\n");

  await dispatchNotification({
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    toEmail: input.toEmail,
    kind: "sign_in_new_device",
    dedupeKey: input.sessionId,
    subject,
    summary,
    text: body,
    href: `/account`,
    payload: {
      sessionId: input.sessionId,
      deviceLabel: input.deviceLabel,
      ipMasked: input.ipMasked,
      reasons: input.reasons,
    },
  });
  return { recipients: 1 };
}

// ─── Cron stalled (post-PRD hardening item 22) ────────────────────────────

/**
 * Notify Acumon operators that a platform cron has stopped succeeding.
 *
 * Recipients = every ACTIVE FIRM_ADMIN + ACUMON_ADMIN of the Acumon
 * operator tenant. The dedupe key is the cronName + an ISO-minute slice
 * of `stalledNotifiedAt` (which the alert module advances per stall
 * window) so a single stall window produces exactly one notification
 * per recipient, but a subsequent stall window can re-alert.
 */
export async function dispatchCronStalled(input: {
  tenantId: string;
  cronName: string;
  state: "stalled" | "failing" | "never-run" | "ok";
  lastSuccessAt: Date | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  expectedIntervalMinutes: number;
}): Promise<{ recipients: number }> {
  // Acumon-side recipients: FIRM_ADMIN + ACUMON_ADMIN with an ACTIVE
  // membership in the operator tenant. Use the operator-recipients helper
  // by intersecting with role-based query directly here (we can't reuse
  // firmAdminRecipients because ACUMON_ADMIN is also load-bearing).
  const rows = await superDb.membership.findMany({
    where: {
      tenantId: input.tenantId,
      status: "ACTIVE",
      role: { in: ["FIRM_ADMIN", "ACUMON_ADMIN"] },
    },
    include: { user: { select: { email: true } } },
  });
  const recipients = rows.filter((r) => !!r.user.email);
  if (recipients.length === 0) return { recipients: 0 };

  // Dedupe key uses a 1-minute slice so concurrent racers within the same
  // health-check pass land on the same key. The alert path's atomic
  // updateMany guards against double-firing across passes, but the
  // dispatch table's unique constraint adds belt-and-braces idempotency.
  const dedupeSlice = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const dedupeKey = `${input.cronName}:${dedupeSlice}`;

  const subject = `Platform cron stalled: ${input.cronName}`;
  const summary =
    input.state === "failing"
      ? `${input.cronName} — ${input.consecutiveFailures} consecutive failures`
      : `${input.cronName} — no successful run in the last ${input.expectedIntervalMinutes * 2} minutes`;
  const body = [
    `An Acumon platform cron has stopped succeeding and requires operator attention.`,
    "",
    `Cron: ${input.cronName}`,
    `State: ${input.state}`,
    `Expected interval: every ${input.expectedIntervalMinutes} minute(s)`,
    `Last success: ${input.lastSuccessAt ? input.lastSuccessAt.toISOString() : "never"}`,
    `Consecutive failures: ${input.consecutiveFailures}`,
    input.lastErrorMessage ? `Last error: ${input.lastErrorMessage}` : null,
    "",
    `Open /<tenant>/admin/health for the full status grid.`,
    `Check Railway cron logs and CRON_SECRET configuration if the schedule looks healthy.`,
  ]
    .filter(Boolean)
    .join("\n");

  for (const r of recipients) {
    await dispatchNotification({
      tenantId: input.tenantId,
      membershipId: r.id,
      toEmail: r.user.email!,
      kind: "cron_stalled",
      dedupeKey,
      subject,
      summary,
      text: body,
      // href omitted — recipient resolves to the operator's own /admin/health
      // via their tenant URL; we don't know which tenant slug they'll use.
      payload: {
        cronName: input.cronName,
        state: input.state,
        consecutiveFailures: input.consecutiveFailures,
      },
    });
  }
  return { recipients: recipients.length };
}

// ─── Sub-processor change notifications (post-PRD hardening item 24) ─────

/**
 * Fan-out helper: every ACTIVE FIRM_ADMIN of every ACTIVE Client tenant
 * (excluding Acumon itself — Acumon is the announcer, not a recipient).
 * Returns one membership per active FIRM_ADMIN with a usable email.
 */
async function clientFirmAdminRecipientsAllTenants(): Promise<
  Array<{ tenantId: string; tenantSlug: string; membershipId: string; toEmail: string }>
> {
  const rows = await superDb.membership.findMany({
    where: {
      status: "ACTIVE",
      role: "FIRM_ADMIN",
      tenant: { status: "ACTIVE", slug: { not: "acumon" } },
    },
    include: {
      user: { select: { email: true } },
      tenant: { select: { slug: true } },
    },
  });
  return rows
    .filter((r) => !!r.user.email)
    .map((r) => ({
      tenantId: r.tenantId,
      tenantSlug: r.tenant.slug,
      membershipId: r.id,
      toEmail: r.user.email!,
    }));
}

function describeChangeKind(kind: "ADDED" | "REMOVED" | "MATERIAL_UPDATE"): string {
  if (kind === "ADDED") return "addition of a new sub-processor";
  if (kind === "REMOVED") return "removal of an existing sub-processor";
  return "material change to an existing sub-processor";
}

export async function dispatchSubProcessorChangeAnnounced(input: {
  changeId: string;
  kind: "ADDED" | "REMOVED" | "MATERIAL_UPDATE";
  description: string;
  effectiveAt: Date;
  subProcessorName: string;
  subProcessorCode: string;
  subProcessorJurisdiction: string;
}): Promise<{ recipients: number }> {
  const recipients = await clientFirmAdminRecipientsAllTenants();
  if (recipients.length === 0) return { recipients: 0 };

  const verb = describeChangeKind(input.kind);
  const effectiveIso = input.effectiveAt.toISOString().slice(0, 10);
  const subject = `Sub-processor change announced: ${input.subProcessorName}`;
  const summary = `${verb} — effective ${effectiveIso}`;
  const body = [
    `Acumon has announced a change to its sub-processor list under DPA art. 28(2)(a).`,
    "",
    `Sub-processor: ${input.subProcessorName} (${input.subProcessorCode})`,
    `Jurisdiction: ${input.subProcessorJurisdiction}`,
    `Change type: ${verb}`,
    `Earliest effective date: ${effectiveIso}`,
    "",
    `Rationale: ${input.description}`,
    "",
    `If your firm objects to this change, raise an objection from the Switching posture page (/<your-tenant>/switching) before the effective date. Objections are non-blocking but are recorded on your tenant's audit chain as the formal evidence of timely objection.`,
  ].join("\n");

  let dispatched = 0;
  for (const r of recipients) {
    await dispatchNotification({
      tenantId: r.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "subprocessor_change_announced",
      dedupeKey: input.changeId,
      subject,
      summary,
      text: body,
      href: `/${r.tenantSlug}/switching`,
      payload: {
        changeId: input.changeId,
        kind: input.kind,
        subProcessorCode: input.subProcessorCode,
      },
    });
    dispatched += 1;
  }
  return { recipients: dispatched };
}

export async function dispatchSubProcessorChangeCancelled(input: {
  changeId: string;
  kind: "ADDED" | "REMOVED" | "MATERIAL_UPDATE";
  reason: string;
  subProcessorName: string;
  subProcessorCode: string;
}): Promise<{ recipients: number }> {
  const recipients = await clientFirmAdminRecipientsAllTenants();
  if (recipients.length === 0) return { recipients: 0 };

  const verb = describeChangeKind(input.kind);
  const subject = `Sub-processor change cancelled: ${input.subProcessorName}`;
  const summary = `Previously-announced ${verb} has been cancelled.`;
  const body = [
    `A previously-announced sub-processor change has been cancelled by Acumon.`,
    "",
    `Sub-processor: ${input.subProcessorName} (${input.subProcessorCode})`,
    `Change type: ${verb}`,
    "",
    `Reason: ${input.reason}`,
    "",
    `No further action is required.`,
  ].join("\n");

  let dispatched = 0;
  for (const r of recipients) {
    await dispatchNotification({
      tenantId: r.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "subprocessor_change_cancelled",
      dedupeKey: `${input.changeId}:cancelled`,
      subject,
      summary,
      text: body,
      href: `/${r.tenantSlug}/switching`,
      payload: {
        changeId: input.changeId,
        kind: input.kind,
        subProcessorCode: input.subProcessorCode,
      },
    });
    dispatched += 1;
  }
  return { recipients: dispatched };
}

export async function dispatchSubProcessorChangeEffective(input: {
  changeId: string;
  kind: "ADDED" | "REMOVED" | "MATERIAL_UPDATE";
  subProcessorName: string;
  subProcessorCode: string;
  effectiveAt: Date;
  noticeOverride: boolean;
}): Promise<{ recipients: number }> {
  const recipients = await clientFirmAdminRecipientsAllTenants();
  if (recipients.length === 0) return { recipients: 0 };

  const verb = describeChangeKind(input.kind);
  const noticeNote = input.noticeOverride
    ? " (operator override — see audit chain for the reason)"
    : "";
  const subject = `Sub-processor change now in effect: ${input.subProcessorName}`;
  const summary = `${verb} has been promoted to effective.`;
  const body = [
    `The sub-processor change previously announced under DPA art. 28(2)(a) has now taken effect${noticeNote}.`,
    "",
    `Sub-processor: ${input.subProcessorName} (${input.subProcessorCode})`,
    `Change type: ${verb}`,
    `Effective: ${input.effectiveAt.toISOString().slice(0, 10)}`,
    "",
    `The Switching posture page (/<your-tenant>/switching) reflects the updated sub-processor list. No action is required from you; this notification closes the notice loop.`,
  ].join("\n");

  let dispatched = 0;
  for (const r of recipients) {
    await dispatchNotification({
      tenantId: r.tenantId,
      membershipId: r.membershipId,
      toEmail: r.toEmail,
      kind: "subprocessor_change_effective",
      dedupeKey: `${input.changeId}:effective`,
      subject,
      summary,
      text: body,
      href: `/${r.tenantSlug}/switching`,
      payload: {
        changeId: input.changeId,
        kind: input.kind,
        subProcessorCode: input.subProcessorCode,
        noticeOverride: input.noticeOverride,
      },
    });
    dispatched += 1;
  }
  return { recipients: dispatched };
}

// ─── Audit chain tampered (post-PRD hardening item 23) ────────────────────

/**
 * Critical security alert: the daily chain-verification cron detected a
 * hash mismatch in `tenant`'s audit chain. Recipients = every ACTIVE
 * FIRM_ADMIN of the affected tenant + every ACTIVE FIRM_ADMIN +
 * ACUMON_ADMIN of the Acumon operator tenant. Chain integrity is a
 * controllership concern for the Client (their data, their DPO) and a
 * processor concern for Acumon (platform-grade incident) — both sides
 * must be notified simultaneously.
 *
 * Dedupe key = `<tenantId>:<failedAtSeq>` — a persistent tamper on the
 * same seq alerts once; tamper that spreads to a different seq re-alerts.
 * The run.ts caller has already claimed `notifiedAt` so two passes can't
 * both reach this code path for the same row.
 */
export async function dispatchAuditChainTampered(input: {
  affectedTenantId: string;
  affectedTenantSlug: string;
  affectedTenantName: string;
  failedAtSeq: number;
}): Promise<{ recipients: number }> {
  const operator = await superDb.tenant.findUnique({
    where: { slug: "acumon" },
    select: { id: true },
  });

  // Affected-tenant FIRM_ADMINs. If the affected tenant IS acumon (a
  // tamper on the operator's own chain), we still want the FIRM_ADMINs
  // here — they ARE the Acumon operators in that case.
  const affectedRows = await superDb.membership.findMany({
    where: {
      tenantId: input.affectedTenantId,
      status: "ACTIVE",
      role: "FIRM_ADMIN",
    },
    include: { user: { select: { email: true } } },
  });

  // Operator-side recipients (FIRM_ADMIN + ACUMON_ADMIN of the acumon
  // tenant). Skip if affected==operator to avoid double-notifying.
  const operatorRows =
    operator && operator.id !== input.affectedTenantId
      ? await superDb.membership.findMany({
          where: {
            tenantId: operator.id,
            status: "ACTIVE",
            role: { in: ["FIRM_ADMIN", "ACUMON_ADMIN"] },
          },
          include: { user: { select: { email: true } } },
        })
      : [];

  const dedupeKey = `${input.affectedTenantId}:${input.failedAtSeq}`;
  const subject = `CRITICAL: Audit chain integrity violation detected — ${input.affectedTenantName}`;
  const summary = `Hash mismatch detected at seq ${input.failedAtSeq}. Manual investigation required.`;
  const body = [
    `The daily audit chain verification has detected a hash mismatch in the per-tenant audit chain.`,
    "",
    `Affected tenant: ${input.affectedTenantName} (${input.affectedTenantSlug})`,
    `First failing event sequence: ${input.failedAtSeq}`,
    "",
    `This indicates one of: (a) direct DB write that bypassed the immutability trigger,`,
    `(b) a backup restore that didn't preserve hash linkage, or (c) a code-path bug.`,
    "",
    `Open /${input.affectedTenantSlug}/admin/audit for the verification history.`,
    `Compare the affected seq against your most recent verified backup before taking any action.`,
    `Per the DPA, contractually-relevant chain integrity is a 24-hour notification obligation —`,
    `confirm whether the affected events touch a personal-data breach record (PRD §12.9) and`,
    `notify Acumon's DPO if so.`,
  ].join("\n");

  let dispatched = 0;
  for (const r of affectedRows) {
    if (!r.user.email) continue;
    await dispatchNotification({
      tenantId: input.affectedTenantId,
      membershipId: r.id,
      toEmail: r.user.email,
      kind: "audit_chain_tampered",
      dedupeKey,
      subject,
      summary,
      text: body,
      href: `/${input.affectedTenantSlug}/admin/audit`,
      payload: {
        affectedTenantSlug: input.affectedTenantSlug,
        failedAtSeq: input.failedAtSeq,
        recipientReason: "affected_firm_admin",
      },
    });
    dispatched += 1;
  }
  for (const r of operatorRows) {
    if (!r.user.email) continue;
    await dispatchNotification({
      tenantId: operator!.id,
      membershipId: r.id,
      toEmail: r.user.email,
      kind: "audit_chain_tampered",
      dedupeKey,
      subject,
      summary,
      text: body,
      payload: {
        affectedTenantSlug: input.affectedTenantSlug,
        failedAtSeq: input.failedAtSeq,
        recipientReason: "acumon_operator",
      },
    });
    dispatched += 1;
  }
  return { recipients: dispatched };
}
