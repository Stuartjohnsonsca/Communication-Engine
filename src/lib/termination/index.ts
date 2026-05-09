import type { Prisma, Tenant, TenantTerminationExport } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §14.4 Tenant Termination + EU Data Act switching support.
 *
 * Lifecycle:
 *   1. notice            — operator records termination notice. Tenant moves
 *                          ACTIVE → TERMINATING. `terminationEffectiveAt`
 *                          defaults to noticeAt + 90 days (PRD-mandated
 *                          hard-delete cut-off; statutory retention exceptions
 *                          apply per §12.5).
 *   2. exportPackage     — operator (or the cron) builds a JSON snapshot of
 *                          everything the Client is entitled to per PRD §14.4:
 *                          FCG versions, UCGs, drafts, meeting records, audit
 *                          chain, DPIA attestations, DSARs, billing periods,
 *                          sign-off questions. The package is stored on
 *                          `TenantTerminationExport` and the tenant's
 *                          `terminationExportPackageId` points to the latest.
 *   3. reverse           — operator can withdraw the notice any time before
 *                          completedAt — tenant returns to ACTIVE; the export
 *                          rows remain (audit trail of what was prepared).
 *   4. hardDeletionSweep — cron-driven; runs over tenants whose
 *                          `terminationEffectiveAt` has passed. Drops the
 *                          §12.5-deletable tables (drafts, ingested messages,
 *                          UCG rules, channels, sentiment, opportunity, etc.).
 *                          Audit chain and DPIA attestations are preserved per
 *                          §12.5; tenant moves TERMINATING → TERMINATED.
 *
 * Audit events for steps 1, 2 and 4 are written against the *operator's*
 * tenant chain (the tenant being terminated). The hash chain itself is
 * append-only and survives hard-deletion.
 */

const DEFAULT_WINDOW_DAYS = 90;
const STATUTORY_RETENTION_DAYS_FALLBACK = 365 * 6; // §12.5: audit + DPIA retention floor

// ─── Notice ──────────────────────────────────────────────────────────────

export type NoticeTerminationInput = {
  tenantId: string;
  byName: string;
  reason?: string | null;
  /** Optional override of the 90-day default window. */
  windowDays?: number;
  actorMembershipId: string;
};

export async function noticeTermination(input: NoticeTerminationInput): Promise<Tenant> {
  const tenant = await superDb.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("termination: tenant not found");
  if (tenant.terminationCompletedAt) {
    throw new Error("termination: tenant has already been hard-deleted");
  }
  if (tenant.terminationNoticeAt) {
    throw new Error("termination: notice has already been recorded");
  }
  if (!input.byName.trim()) throw new Error("termination: signer name required");

  const window = clampInt(input.windowDays ?? DEFAULT_WINDOW_DAYS, 1, 365);
  const now = new Date();
  const effectiveAt = new Date(now.getTime() + window * 24 * 60 * 60 * 1000);

  const updated = await superDb.tenant.update({
    where: { id: tenant.id },
    data: {
      status: "TERMINATING",
      terminationNoticeAt: now,
      terminationByName: input.byName.trim(),
      terminationReason: input.reason?.trim() || null,
      terminationEffectiveAt: effectiveAt,
    },
  });

  await writeAuditEvent({
    tenantId: tenant.id,
    eventType: "TENANT_TERMINATION_NOTICED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: tenant.id,
    payload: {
      windowDays: window,
      effectiveAt: effectiveAt.toISOString(),
      hadReason: !!input.reason?.trim(),
    },
  });

  return updated;
}

export type ReverseTerminationInput = {
  tenantId: string;
  byName: string;
  notes?: string | null;
  actorMembershipId: string;
};

export async function reverseTermination(input: ReverseTerminationInput): Promise<Tenant> {
  const tenant = await superDb.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("termination: tenant not found");
  if (!tenant.terminationNoticeAt) throw new Error("termination: no notice to reverse");
  if (tenant.terminationCompletedAt) {
    throw new Error("termination: hard-deletion already ran — cannot reverse");
  }
  if (!input.byName.trim()) throw new Error("termination: signer name required");

  const updated = await superDb.tenant.update({
    where: { id: tenant.id },
    data: {
      status: "ACTIVE",
      terminationNoticeAt: null,
      terminationByName: null,
      terminationReason: null,
      terminationEffectiveAt: null,
    },
  });

  await writeAuditEvent({
    tenantId: tenant.id,
    eventType: "TENANT_TERMINATION_REVERSED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: tenant.id,
    payload: {
      byName: input.byName.trim(),
      hadNotes: !!input.notes?.trim(),
      previousNoticeAt: tenant.terminationNoticeAt.toISOString(),
    },
  });

  return updated;
}

// ─── Export package ──────────────────────────────────────────────────────

export type GenerateExportInput = {
  tenantId: string;
  generatedByMembershipId?: string | null;
  generatedByName?: string | null;
  actorMembershipId: string;
};

export async function generateExportPackage(
  input: GenerateExportInput,
): Promise<TenantTerminationExport> {
  const tenant = await superDb.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("termination: tenant not found");
  if (tenant.terminationCompletedAt) {
    throw new Error("termination: tenant has been hard-deleted; no live data to export");
  }

  const [
    fcgs,
    ucgs,
    drafts,
    actions,
    meetings,
    meetingRecords,
    auditEvents,
    dpia,
    dsars,
    billingPeriods,
    billingSnapshots,
    signOffQuestions,
    channels,
    ingestedMessages,
    opportunities,
    sentiments,
    adherence,
    members,
    termsRecords,
  ] = await Promise.all([
    superDb.firmCultureGuide.findMany({
      where: { tenantId: tenant.id },
      include: { rules: true },
      orderBy: { version: "asc" },
    }),
    superDb.userCultureGuide.findMany({
      where: { tenantId: tenant.id },
      include: { rules: true, rulings: true },
      orderBy: [{ membershipId: "asc" }, { version: "asc" }],
    }),
    superDb.draft.findMany({
      where: { tenantId: tenant.id },
      include: { adherence: true, actions: true },
      orderBy: { createdAt: "asc" },
    }),
    superDb.action.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    superDb.meeting.findMany({
      where: { tenantId: tenant.id },
      include: { participants: true },
      orderBy: { startsAt: "asc" },
    }),
    superDb.meetingRecord.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    superDb.auditEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { seq: "asc" },
    }),
    superDb.dPIAAttestation.findMany({
      where: { tenantId: tenant.id },
      orderBy: { signedAt: "asc" },
    }),
    superDb.dSARequest.findMany({
      where: { tenantId: tenant.id },
      orderBy: { openedAt: "asc" },
    }),
    superDb.billingPeriod.findMany({
      where: { tenantId: tenant.id },
      orderBy: { period: "asc" },
    }),
    superDb.billingUserSnapshot.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    superDb.signOffQuestion.findMany({
      where: { tenantId: tenant.id },
      orderBy: { ordinal: "asc" },
    }),
    superDb.channel.findMany({ where: { tenantId: tenant.id } }),
    superDb.ingestedMessage.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    superDb.opportunityCandidate.findMany({
      where: { tenantId: tenant.id },
      include: { comments: true },
      orderBy: { createdAt: "asc" },
    }),
    superDb.sentimentSignal.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    superDb.adherenceScore.findMany({
      where: { tenantId: tenant.id },
      orderBy: { period: "asc" },
    }),
    superDb.membership.findMany({
      where: { tenantId: tenant.id },
      include: { user: { select: { id: true, email: true, name: true, createdAt: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    superDb.termsRecord.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ kind: "asc" }, { version: "asc" }],
    }),
  ]);

  const counts = {
    fcgs: fcgs.length,
    ucgs: ucgs.length,
    drafts: drafts.length,
    actions: actions.length,
    meetings: meetings.length,
    meetingRecords: meetingRecords.length,
    auditEvents: auditEvents.length,
    dpiaAttestations: dpia.length,
    dsarRequests: dsars.length,
    billingPeriods: billingPeriods.length,
    billingSnapshots: billingSnapshots.length,
    signOffQuestions: signOffQuestions.length,
    channels: channels.length,
    ingestedMessages: ingestedMessages.length,
    opportunityCandidates: opportunities.length,
    sentimentSignals: sentiments.length,
    adherenceScores: adherence.length,
    members: members.length,
    termsRecords: termsRecords.length,
  };

  const payload = {
    meta: {
      schema: "acumon.termination-export@1",
      generatedAt: new Date().toISOString(),
      generatedByName: input.generatedByName ?? null,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        jurisdiction: tenant.jurisdiction,
        status: tenant.status,
        createdAt: tenant.createdAt.toISOString(),
      },
    },
    counts,
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      status: m.status,
      perfDashOptIn: m.perfDashOptIn,
      sentimentOutOptIn: m.sentimentOutOptIn,
      joinedAt: m.joinedAt.toISOString(),
      leftAt: m.leftAt?.toISOString() ?? null,
      anonymisedAt: m.anonymisedAt?.toISOString() ?? null,
      user: m.user,
    })),
    fcgs,
    ucgs,
    drafts,
    actions,
    meetings,
    meetingRecords,
    auditEvents: auditEvents.map((e) => ({
      ...e,
      seq: e.seq.toString(), // BigInt → string for JSON portability
    })),
    dpiaAttestations: dpia,
    dsarRequests: dsars,
    billingPeriods,
    billingSnapshots,
    signOffQuestions,
    channels,
    ingestedMessages,
    opportunityCandidates: opportunities,
    sentimentSignals: sentiments,
    adherenceScores: adherence,
    termsRecords,
  } as unknown as Prisma.InputJsonValue;

  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, "utf8");

  const created = await superDb.tenantTerminationExport.create({
    data: {
      tenantId: tenant.id,
      generatedByMembershipId: input.generatedByMembershipId ?? null,
      generatedByName: input.generatedByName ?? null,
      payload,
      bytes,
      counts: counts as unknown as Prisma.InputJsonValue,
    },
  });

  await superDb.tenant.update({
    where: { id: tenant.id },
    data: { terminationExportPackageId: created.id },
  });

  await writeAuditEvent({
    tenantId: tenant.id,
    eventType: "TENANT_TERMINATION_EXPORT_GENERATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TenantTerminationExport",
    subjectId: created.id,
    payload: { bytes, counts: counts as Prisma.InputJsonValue },
  });

  return created;
}

// ─── Hard deletion ───────────────────────────────────────────────────────

export type HardDeletionResult = {
  /** Tenants that were swept this run, with count of rows removed per table. */
  tenants: Array<{
    tenantId: string;
    slug: string;
    removed: Record<string, number>;
  }>;
};

/**
 * Cron-driven sweep. Runs over tenants whose `terminationEffectiveAt` has
 * passed and whose `terminationCompletedAt` is null. Idempotent — once
 * `terminationCompletedAt` is set on a tenant, the sweep skips it.
 *
 * §12.5 retention is implemented by NOT deleting AuditEvent and
 * DPIAAttestation rows. The Tenant row itself stays (set to TERMINATED) so
 * the audit chain remains queryable. A `terminationStatutoryRetentionUntil`
 * date is stamped on the tenant for downstream sweeps to honour.
 */
export async function runHardDeletionSweep(): Promise<HardDeletionResult> {
  const now = new Date();
  const due = await superDb.tenant.findMany({
    where: {
      status: "TERMINATING",
      terminationEffectiveAt: { lte: now },
      terminationCompletedAt: null,
    },
    select: { id: true, slug: true },
  });

  const tenants: HardDeletionResult["tenants"] = [];

  for (const t of due) {
    const removed = await hardDeleteTenant(t.id);
    tenants.push({ tenantId: t.id, slug: t.slug, removed });
  }

  return { tenants };
}

export async function hardDeleteTenant(tenantId: string): Promise<Record<string, number>> {
  const tenant = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("termination: tenant not found");
  if (tenant.terminationCompletedAt) {
    return {}; // idempotent
  }
  if (!tenant.terminationEffectiveAt || tenant.terminationEffectiveAt > new Date()) {
    throw new Error("termination: window not yet elapsed");
  }

  const removed: Record<string, number> = {};

  // Order matters — children first, then parents.
  const tables: Array<{ name: string; del: () => Promise<{ count: number }> }> = [
    {
      name: "communicationAdherence",
      del: () => superDb.communicationAdherence.deleteMany({ where: { tenantId } }),
    },
    {
      name: "adherenceScore",
      del: () => superDb.adherenceScore.deleteMany({ where: { tenantId } }),
    },
    {
      name: "sentimentSignal",
      del: () => superDb.sentimentSignal.deleteMany({ where: { tenantId } }),
    },
    {
      name: "opportunityComment",
      del: () => superDb.opportunityComment.deleteMany({ where: { tenantId } }),
    },
    {
      name: "opportunityCandidate",
      del: () => superDb.opportunityCandidate.deleteMany({ where: { tenantId } }),
    },
    {
      name: "action",
      del: () => superDb.action.deleteMany({ where: { tenantId } }),
    },
    {
      name: "draft",
      del: () => superDb.draft.deleteMany({ where: { tenantId } }),
    },
    {
      name: "ingestedMessage",
      del: () => superDb.ingestedMessage.deleteMany({ where: { tenantId } }),
    },
    {
      name: "channelAuth",
      del: () => superDb.channelAuth.deleteMany({ where: { tenantId } }),
    },
    {
      name: "channel",
      del: () => superDb.channel.deleteMany({ where: { tenantId } }),
    },
    {
      name: "meetingRecord",
      del: () => superDb.meetingRecord.deleteMany({ where: { tenantId } }),
    },
    {
      name: "meetingParticipant",
      del: () => superDb.meetingParticipant.deleteMany({ where: { tenantId } }),
    },
    {
      name: "meeting",
      del: () => superDb.meeting.deleteMany({ where: { tenantId } }),
    },
    {
      name: "complianceRuling",
      del: () => superDb.complianceRuling.deleteMany({ where: { tenantId } }),
    },
    {
      name: "ucgChatTurn",
      del: () => superDb.uCGChatTurn.deleteMany({ where: { tenantId } }),
    },
    {
      name: "ucgRule",
      del: () => superDb.uCGRule.deleteMany({ where: { tenantId } }),
    },
    {
      name: "userCultureGuide",
      del: () => superDb.userCultureGuide.deleteMany({ where: { tenantId } }),
    },
    {
      name: "fcgVote",
      del: () => superDb.fCGVote.deleteMany({ where: { tenantId } }),
    },
    {
      name: "fcgChatTurn",
      del: () => superDb.fCGChatTurn.deleteMany({ where: { tenantId } }),
    },
    {
      name: "fcgProposal",
      del: () => superDb.fCGProposal.deleteMany({ where: { tenantId } }),
    },
    {
      name: "fcgRule",
      del: () => superDb.fCGRule.deleteMany({ where: { tenantId } }),
    },
    {
      name: "firmCultureGuide",
      del: () => superDb.firmCultureGuide.deleteMany({ where: { tenantId } }),
    },
    {
      name: "noGoSubject",
      del: () => superDb.noGoSubject.deleteMany({ where: { tenantId } }),
    },
    {
      name: "billingUserSnapshot",
      del: () => superDb.billingUserSnapshot.deleteMany({ where: { tenantId } }),
    },
    {
      name: "billingPeriod",
      del: () => superDb.billingPeriod.deleteMany({ where: { tenantId } }),
    },
    {
      name: "signOffQuestion",
      del: () => superDb.signOffQuestion.deleteMany({ where: { tenantId } }),
    },
    {
      name: "dsarRequest",
      del: () => superDb.dSARequest.deleteMany({ where: { tenantId } }),
    },
    // §12.5 + §15.4 retention floor: AuditEvent + DPIAAttestation +
    // TermsRecord are NOT deleted. Memberships are kept so audit-event
    // actorMembershipId joins still work for the retention period;
    // user-personal data on the User row is anonymised separately by the
    // §14.3 lifecycle module. TermsRecord persists per §15.4 ("persistent
    // until changed; survive non-renewal") for audit-log access and DSAR
    // fulfilment after termination.
  ];

  for (const t of tables) {
    const r = await t.del();
    removed[t.name] = r.count;
  }

  const completedAt = new Date();
  const retentionUntil =
    tenant.terminationStatutoryRetentionUntil ??
    new Date(completedAt.getTime() + STATUTORY_RETENTION_DAYS_FALLBACK * 24 * 60 * 60 * 1000);

  await superDb.tenant.update({
    where: { id: tenantId },
    data: {
      status: "TERMINATED",
      terminationCompletedAt: completedAt,
      terminationStatutoryRetentionUntil: retentionUntil,
    },
  });

  await writeAuditEvent({
    tenantId,
    eventType: "TENANT_HARD_DELETED",
    actorMembershipId: null,
    subjectType: "Tenant",
    subjectId: tenantId,
    payload: {
      removed: removed as Prisma.InputJsonValue,
      statutoryRetentionUntil: retentionUntil.toISOString(),
    },
  });

  return removed;
}

// ─── Views ────────────────────────────────────────────────────────────────

export type TerminationView = {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    terminationNoticeAt: Date | null;
    terminationByName: string | null;
    terminationReason: string | null;
    terminationEffectiveAt: Date | null;
    terminationCompletedAt: Date | null;
    terminationStatutoryRetentionUntil: Date | null;
    terminationExportPackageId: string | null;
  };
  exports: {
    id: string;
    generatedAt: Date;
    generatedByName: string | null;
    bytes: number;
    counts: unknown;
  }[];
};

export async function getTerminationView(tenantId: string): Promise<TerminationView> {
  const tenant = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("termination: tenant not found");

  const exports = await superDb.tenantTerminationExport.findMany({
    where: { tenantId },
    orderBy: { generatedAt: "desc" },
    select: {
      id: true,
      generatedAt: true,
      generatedByName: true,
      bytes: true,
      counts: true,
    },
    take: 10,
  });

  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      terminationNoticeAt: tenant.terminationNoticeAt,
      terminationByName: tenant.terminationByName,
      terminationReason: tenant.terminationReason,
      terminationEffectiveAt: tenant.terminationEffectiveAt,
      terminationCompletedAt: tenant.terminationCompletedAt,
      terminationStatutoryRetentionUntil: tenant.terminationStatutoryRetentionUntil,
      terminationExportPackageId: tenant.terminationExportPackageId,
    },
    exports,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
