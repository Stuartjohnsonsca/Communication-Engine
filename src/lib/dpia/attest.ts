import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { computeLiveScope, ATTESTATION_TTL_DAYS } from "@/lib/dpia/status";

/**
 * Sections of the DPIA captured by the Helper (PRD §12.2). Stored as part
 * of the attestation `scope` payload so we can prove a specific decision
 * was acknowledged at sign-off.
 */
export type DpiaAttestInput = {
  tenantId: string;
  actorMembershipId: string;
  signedByName: string;
  signedByRole: string;
  documentRef?: string | null;
  sections: {
    channelsAcknowledged: boolean;
    retentionAcknowledged: boolean;
    lawfulBasis: "LEGITIMATE_INTERESTS" | "CONSENT" | "CONTRACT";
    lawfulBasisNotes?: string | null;
    specialCategoryDataInScope: boolean;
    specialCategoryNotes?: string | null;
    transferInRegionConfirmed: boolean;
    subProcessorsAcknowledged: boolean;
    subProcessorsList: string[];
    performanceProportionalityAcknowledged: boolean;
    sentimentScopeAcknowledged: boolean;
    salesIdentifierOptIn: boolean;
  };
};

export async function commitDpiaAttestation(input: DpiaAttestInput) {
  // Sign-off is only valid if every required acknowledgement is set. The PRD
  // is explicit that Helper output is *signed off* by the Client; we do not
  // accept a partial sign-off as an attestation.
  const s = input.sections;
  const required = [
    s.channelsAcknowledged,
    s.retentionAcknowledged,
    s.transferInRegionConfirmed,
    s.subProcessorsAcknowledged,
    s.performanceProportionalityAcknowledged,
    s.sentimentScopeAcknowledged,
  ];
  if (required.some((v) => !v)) {
    throw new Error("DPIA: every section must be acknowledged before sign-off");
  }
  if (!input.signedByName.trim() || !input.signedByRole.trim()) {
    throw new Error("DPIA: signer name and role required");
  }

  const liveScope = await computeLiveScope(input.tenantId);
  const signedAt = new Date();
  const expiresAt = new Date(signedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + ATTESTATION_TTL_DAYS);

  const previous = await superDb.dPIAAttestation.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (previous?.version ?? 0) + 1;

  const scopePayload = {
    snapshot: liveScope,
    sections: s,
    documentRef: input.documentRef ?? null,
  } as const;

  const attestation = await superDb.$transaction(async (tx) => {
    const att = await tx.dPIAAttestation.create({
      data: {
        tenantId: input.tenantId,
        version,
        scope: scopePayload as unknown as Prisma.InputJsonValue,
        signedByName: input.signedByName.trim(),
        signedByRole: input.signedByRole.trim(),
        signedAt,
        expiresAt,
        documentRef: input.documentRef?.trim() || null,
      },
    });

    // Channels in scope are flagged dpiaApproved=true so the Channels admin
    // page reflects sign-off without the FIRM_ADMIN having to revisit each
    // channel manually. Channels not in scope (e.g. INACTIVE) are untouched.
    await tx.channel.updateMany({
      where: { tenantId: input.tenantId, status: { not: "INACTIVE" } },
      data: { dpiaApproved: true },
    });

    return att;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "DPIA_ATTESTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "DPIAAttestation",
    subjectId: attestation.id,
    payload: {
      version,
      signedByName: attestation.signedByName,
      signedByRole: attestation.signedByRole,
      signedAt: signedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scopeHash: liveScope.hash,
      lawfulBasis: s.lawfulBasis,
      specialCategoryDataInScope: s.specialCategoryDataInScope,
      salesIdentifierOptIn: s.salesIdentifierOptIn,
      channelKinds: liveScope.channelKinds,
      perfDashOptInUserCount: liveScope.perfDashOptInUserCount,
      sentimentOutOptInUserCount: liveScope.sentimentOutOptInUserCount,
    },
  });

  return attestation;
}
