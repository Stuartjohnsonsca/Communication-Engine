import type { ChannelKind } from "@/lib/channels/registry";
import type { FirmCultureScan, Membership, Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { analyseCultureScan } from "@/lib/ai/agents/cultureScanAgent";
import type { CultureScanResult } from "@/lib/ai/schemas";

/**
 * PRD §5.1.1 Firm Culture Scan.
 *
 * The Firm Administrator launches a bounded scan over the FCT's communications
 * (date range + channel scope set under DPIA) and the system produces a draft
 * FCG by analysing observed tone, response times, salutations, sign-offs,
 * mandatory/prohibited phrases, escalation patterns, regulatory phrases and
 * signature blocks. The output is staged as an `FCGProposal` so the FCT
 * still has to review and run it through the §6 quorum vote — promotion is
 * never silent.
 *
 * The scan reads `IngestedMessage` rows authored by FCT-member memberships
 * (per the PRD's "system sends an authorisation message to each member of the
 * Firm Culture Team" framing) within the chosen date range and channel scope,
 * caps at `MAX_CORPUS_MESSAGES`, and feeds the corpus to the culture-scan
 * agent. The agent's output is persisted as `analysisResult` and lifted into
 * a DRAFTING-state proposal. Audit events on the tenant chain mirror the
 * sandbox/termination/terms patterns:
 *   FCG_SCAN_INITIATED   — scan record created
 *   FCG_SCAN_COMPLETED   — analyser succeeded, proposal staged
 *   FCG_SCAN_FAILED      — analyser errored
 *   FCG_SCAN_PROMOTED    — operator opened the staged proposal for vote
 *   FCG_SCAN_DISCARDED   — operator dropped the scan output without using it
 */

const MAX_CORPUS_MESSAGES = 200;
const MAX_BODY_CHARS = 4000;
const MAX_DATE_RANGE_DAYS = 365;

// ─── Initiation ───────────────────────────────────────────────────────────

export type InitiateScanInput = {
  tenantId: string;
  /** Operator's membership id. Must hold `fcg:scan:run` (FIRM_ADMIN). */
  initiatedById: string;
  dateRangeFrom: Date;
  dateRangeTo: Date;
  /** Channel kinds in DPIA scope. Empty = all kinds the tenant has authorised. */
  channelKinds: ChannelKind[];
};

export async function initiateScan(input: InitiateScanInput): Promise<FirmCultureScan> {
  if (input.dateRangeFrom.getTime() >= input.dateRangeTo.getTime()) {
    throw new Error("culture-scan: dateRangeFrom must be before dateRangeTo");
  }
  const rangeDays = (input.dateRangeTo.getTime() - input.dateRangeFrom.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > MAX_DATE_RANGE_DAYS) {
    throw new Error(`culture-scan: date range exceeds ${MAX_DATE_RANGE_DAYS} days`);
  }

  // PRD §12.2 — DPIA gate. The tenant must have an attested DPIA before any
  // scan touches communications. The scan is a different processing purpose
  // from drafting (it pulls broadly across the FCT) so this is enforced
  // independently of the channel-level dpiaApproved flag. A DPIAAttestation
  // row only exists once §12.2 is signed off — presence is attestation.
  const dpia = await superDb.dPIAAttestation.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!dpia) {
    throw new Error("culture-scan: tenant has no DPIA attestation — complete §12.2 first");
  }

  const scan = await superDb.firmCultureScan.create({
    data: {
      tenantId: input.tenantId,
      initiatedById: input.initiatedById,
      dateRangeFrom: input.dateRangeFrom,
      dateRangeTo: input.dateRangeTo,
      channelKinds: input.channelKinds as unknown as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FCG_SCAN_INITIATED",
    actorMembershipId: input.initiatedById,
    subjectType: "FirmCultureScan",
    subjectId: scan.id,
    payload: {
      dateRangeFrom: input.dateRangeFrom.toISOString(),
      dateRangeTo: input.dateRangeTo.toISOString(),
      channelKinds: input.channelKinds,
      dpiaAttestationId: dpia.id,
    },
  });

  return scan;
}

// ─── Run ──────────────────────────────────────────────────────────────────

/**
 * Pull the corpus, analyse, and stage the proposal. Synchronous in v1 — for
 * Pilot scale (≤10k users, scan corpus capped at 200 messages) the analyser
 * round-trip is well within an HTTP request budget. If/when scans grow
 * larger this becomes a queue worker; the lifecycle states (PENDING →
 * ANALYSING → DRAFTED|ERRORED) are already shaped for that.
 */
export async function runScan(scanId: string): Promise<FirmCultureScan> {
  const scan = await superDb.firmCultureScan.findUnique({ where: { id: scanId } });
  if (!scan) throw new Error("culture-scan: not found");
  if (scan.status !== "PENDING") {
    throw new Error(`culture-scan: cannot run a scan in status ${scan.status}`);
  }

  await superDb.firmCultureScan.update({
    where: { id: scan.id },
    data: { status: "ANALYSING" },
  });

  try {
    const corpus = await pullCorpus(scan);
    if (corpus.length === 0) {
      const errored = await markErrored(
        scan.id,
        "no FCT-member messages were found in the chosen date range and channel scope",
      );
      return errored;
    }

    const tenant = await superDb.tenant.findUnique({ where: { id: scan.tenantId } });
    const committedFcg = await superDb.firmCultureGuide.findFirst({
      where: { tenantId: scan.tenantId, status: "COMMITTED" },
      orderBy: { version: "desc" },
    });

    const { result, modelRunId } = await analyseCultureScan({
      tenantJurisdiction: tenant?.jurisdiction ?? "UK",
      workingLanguage: committedFcg?.language ?? "en-GB",
      channelsInScope: corpus.map((m) => m.channelKind).filter((v, i, a) => a.indexOf(v) === i),
      dateRangeFrom: scan.dateRangeFrom.toISOString(),
      dateRangeTo: scan.dateRangeTo.toISOString(),
      corpus,
    });

    const proposal = await stageProposal({
      tenantId: scan.tenantId,
      initiatedById: scan.initiatedById,
      result,
      committedFcgId: committedFcg?.id ?? null,
    });

    const updated = await superDb.firmCultureScan.update({
      where: { id: scan.id },
      data: {
        status: "DRAFTED",
        messagesAnalysed: corpus.length,
        analysisResult: result as unknown as Prisma.InputJsonValue,
        proposalId: proposal.id,
        completedAt: new Date(),
      },
    });

    await writeAuditEvent({
      tenantId: scan.tenantId,
      eventType: "FCG_SCAN_COMPLETED",
      actorMembershipId: scan.initiatedById,
      subjectType: "FirmCultureScan",
      subjectId: scan.id,
      payload: {
        proposalId: proposal.id,
        messagesAnalysed: corpus.length,
        rulesProposed: result.proposedRules.length,
        gapsFlagged: result.gapsFlagged,
        modelRunId: modelRunId ?? null,
      },
    });

    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return markErrored(scan.id, message);
  }
}

async function markErrored(scanId: string, message: string): Promise<FirmCultureScan> {
  const updated = await superDb.firmCultureScan.update({
    where: { id: scanId },
    data: {
      status: "ERRORED",
      errorMessage: message,
      completedAt: new Date(),
    },
  });
  await writeAuditEvent({
    tenantId: updated.tenantId,
    eventType: "FCG_SCAN_FAILED",
    actorMembershipId: updated.initiatedById,
    subjectType: "FirmCultureScan",
    subjectId: updated.id,
    payload: { error: message },
  });
  return updated;
}

// ─── Corpus ───────────────────────────────────────────────────────────────

type CorpusMessage = {
  id: string;
  channelKind: string;
  direction: string;
  sender: string | null;
  subject: string | null;
  body: string;
  sentAt: string | null;
};

async function pullCorpus(scan: FirmCultureScan): Promise<CorpusMessage[]> {
  // PRD §5.1.1 frames the scan around "each member of the Firm Culture Team"
  // — pull only IngestedMessage rows whose sender resolves to an FCT member's
  // email (out-direction) or whose channelAuth was minted by an FCT member.
  const fctMemberships = await superDb.membership.findMany({
    where: { tenantId: scan.tenantId, role: { in: ["FCT_MEMBER", "FIRM_ADMIN"] }, status: "ACTIVE" },
    include: { user: { select: { email: true } } },
  });
  const fctEmails = fctMemberships.map((m) => m.user.email.toLowerCase());
  const fctMembershipIds = fctMemberships.map((m) => m.id);

  const channelKinds = (scan.channelKinds as unknown as string[]) ?? [];

  const channelFilter = channelKinds.length
    ? { channel: { kind: { in: channelKinds }, tenantId: scan.tenantId } }
    : {};

  // Two ways an FCT-member message can be in the corpus:
  //   (a) out-direction with sender matching an FCT email; or
  //   (b) any direction on a channelAuth held by an FCT membership.
  const fctChannelAuths = await superDb.channelAuth.findMany({
    where: {
      tenantId: scan.tenantId,
      membershipId: { in: fctMembershipIds },
      revokedAt: null,
    },
    select: { channelId: true },
  });
  const fctChannelIds = Array.from(new Set(fctChannelAuths.map((a) => a.channelId)));

  const where: Prisma.IngestedMessageWhereInput = {
    tenantId: scan.tenantId,
    sentAt: { gte: scan.dateRangeFrom, lte: scan.dateRangeTo },
    ...channelFilter,
    OR: [
      { sender: { in: fctEmails, mode: "insensitive" } },
      ...(fctChannelIds.length ? [{ channelId: { in: fctChannelIds } }] : []),
    ],
  };

  const rows = await superDb.ingestedMessage.findMany({
    where,
    include: { channel: { select: { kind: true } } },
    orderBy: { sentAt: "desc" },
    take: MAX_CORPUS_MESSAGES,
  });

  return rows.map((r) => ({
    id: r.id,
    channelKind: r.channel?.kind ?? "UNKNOWN",
    direction: r.direction,
    sender: r.sender,
    subject: r.subject,
    body: truncate(r.body, MAX_BODY_CHARS),
    sentAt: r.sentAt?.toISOString() ?? null,
  }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ─── Stage proposal ───────────────────────────────────────────────────────

/**
 * Lift the analyser's `proposedRules` into a DRAFTING-state `FCGProposal`
 * the FCT can review and open for vote. Each rule becomes a single
 * `propose_rule_change` op with action `add`. We persist the message-id
 * evidence onto FCGRule.evidenceRefs once the proposal is committed by the
 * normal vote flow — at staging time the references live in the diff ops.
 */
async function stageProposal(input: {
  tenantId: string;
  initiatedById: string;
  result: CultureScanResult;
  committedFcgId: string | null;
}) {
  const ops = input.result.proposedRules.map((r) => ({
    tool: "propose_rule_change" as const,
    input: {
      action: "add",
      rule: {
        externalId: r.externalId,
        category: r.category.toUpperCase(),
        channel: r.channel.toUpperCase(),
        statement: r.statement,
        payload: r.payload,
        rationale: r.rationale,
        mandatory: r.mandatory,
        priority: r.priority,
        evidenceRefs: r.evidenceMessageIds,
        channelOverrides: r.channelOverrides,
      },
      rationale: r.rationale ?? "Proposed from Firm Culture Scan",
    },
  }));

  return superDb.fCGProposal.create({
    data: {
      tenantId: input.tenantId,
      parentFcgId: input.committedFcgId,
      title: input.committedFcgId
        ? "Firm Culture Scan — proposed amendments"
        : "Firm Culture Scan — initial draft",
      body: input.result.summary,
      diff: { ops, gapsFlagged: input.result.gapsFlagged } as unknown as Prisma.InputJsonValue,
      proposedById: input.initiatedById,
      state: "DRAFTING",
    },
  });
}

// ─── Operator actions ─────────────────────────────────────────────────────

export type DiscardScanInput = {
  scanId: string;
  tenantId: string;
  actorMembershipId: string;
  reason?: string;
};

export async function discardScan(input: DiscardScanInput): Promise<FirmCultureScan> {
  const scan = await superDb.firmCultureScan.findFirst({
    where: { id: input.scanId, tenantId: input.tenantId },
  });
  if (!scan) throw new Error("culture-scan: not found");
  if (scan.status === "PROMOTED") {
    throw new Error("culture-scan: already promoted to a vote — close the proposal instead");
  }

  // If the scan staged a DRAFTING proposal that hasn't been opened, withdraw
  // it. Once it's OPEN_FOR_VOTE the proposal lifecycle owns it — discarding
  // the scan record at that point only un-links the scan, not the proposal.
  if (scan.proposalId) {
    const proposal = await superDb.fCGProposal.findUnique({ where: { id: scan.proposalId } });
    if (proposal && proposal.state === "DRAFTING") {
      await superDb.fCGProposal.update({
        where: { id: proposal.id },
        data: { state: "WITHDRAWN" },
      });
    }
  }

  const updated = await superDb.firmCultureScan.update({
    where: { id: scan.id },
    data: { status: "DISCARDED", completedAt: scan.completedAt ?? new Date() },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FCG_SCAN_DISCARDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "FirmCultureScan",
    subjectId: scan.id,
    payload: { reason: input.reason ?? null, hadProposal: !!scan.proposalId },
  });

  return updated;
}

/**
 * Mark the scan as PROMOTED once the FCT opens its proposal for vote. Called
 * from the proposal-open route via a hook so the scan's lifecycle stays in
 * sync without duplicating governance logic here.
 */
export async function recordPromotion(input: {
  scanId: string;
  tenantId: string;
  actorMembershipId: string | null;
}): Promise<FirmCultureScan> {
  const updated = await superDb.firmCultureScan.update({
    where: { id: input.scanId },
    data: { status: "PROMOTED" },
  });
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FCG_SCAN_PROMOTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "FirmCultureScan",
    subjectId: input.scanId,
    payload: { proposalId: updated.proposalId },
  });
  return updated;
}

// ─── Views ────────────────────────────────────────────────────────────────

export type ScanListItem = FirmCultureScan & {
  initiatedBy: Pick<Membership, "id" | "userId"> & { user: { email: string; name: string | null } };
};

export async function listScans(tenantId: string, take = 20): Promise<ScanListItem[]> {
  return superDb.firmCultureScan.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      initiatedBy: {
        select: {
          id: true,
          userId: true,
          user: { select: { email: true, name: true } },
        },
      },
    },
  });
}

export async function getScan(scanId: string, tenantId: string) {
  return superDb.firmCultureScan.findFirst({
    where: { id: scanId, tenantId },
    include: {
      initiatedBy: {
        select: {
          id: true,
          userId: true,
          user: { select: { email: true, name: true } },
        },
      },
      proposal: true,
    },
  });
}
