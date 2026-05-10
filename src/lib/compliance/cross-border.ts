import type { Prisma, SubProcessor, Tenant, TransferImpactAssessment } from "@prisma/client";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §12.6 Cross-Border Transfer.
 *
 * v1 default: all Client tenant data resides in the configured jurisdiction
 * (UK or EU). Inference uses an in-region endpoint with no-training /
 * no-retention commitments. **No third-country transfers occur unless the
 * Client has signed SCCs and a documented Transfer Impact Assessment for
 * that tenant × sub-processor pair.**
 *
 * The global `SubProcessor` table (§15.3) is the catalogue. Each row carries
 * a `jurisdiction` string; if it is anything other than UK / EU-IE / EU-DE /
 * EU-FR, we treat it as a third-country sub-processor. Per-tenant
 * authorisation lives in `TransferImpactAssessment` and is required before
 * activation gates (e.g. enabling Sales Identifier through a US-resident
 * partner) will let the operator proceed.
 */

const DEFAULT_TIA_VALIDITY_MONTHS = 12;

/** Jurisdictions Acumon treats as in-region (no TIA required). */
const IN_REGION_JURISDICTIONS = new Set([
  "UK",
  "EU",
  "EU-IE",
  "EU-DE",
  "EU-FR",
  "Ireland",
  "Frankfurt",
  "Paris",
]);

export function isThirdCountry(jurisdiction: string): boolean {
  const normalised = jurisdiction.trim();
  if (!normalised) return true;
  if (IN_REGION_JURISDICTIONS.has(normalised)) return false;
  // The tenant's jurisdiction is enumerated UK / EU_IE / EU_DE / EU_FR. The
  // sub-processor jurisdiction is free-form (could be "EU-IE" or "Ireland"
  // or "ie" depending on operator entry), so be lenient on the prefix.
  if (/^EU[-_ ]/i.test(normalised)) return false;
  if (/^UK\b/i.test(normalised)) return false;
  return true;
}

export type SubProcessorWithTia = SubProcessor & {
  thirdCountry: boolean;
  tia: TransferImpactAssessment | null;
  tiaState: "in-region" | "covered" | "expiring-soon" | "missing" | "expired" | "revoked";
};

/**
 * Per-tenant view: every active sub-processor decorated with whether it is
 * a third-country row and, if so, the tenant's TIA state for it.
 */
export async function getCrossBorderView(tenant: Tenant): Promise<{
  rows: SubProcessorWithTia[];
  tenantJurisdiction: string;
  thirdCountryCount: number;
  uncovered: SubProcessorWithTia[];
  expiringSoon: SubProcessorWithTia[];
}> {
  const subprocessors = await superDb.subProcessor.findMany({
    where: { isActive: true },
    orderBy: { ordinal: "asc" },
  });
  const tias = await tenantDb(tenant.id).transferImpactAssessment.findMany({
    where: { tenantId: tenant.id },
  });
  const byCode = new Map<string, TransferImpactAssessment>();
  for (const t of tias) {
    // Pick the most recent record per sub-processor.
    const existing = byCode.get(t.subProcessorCode);
    if (!existing || t.effectiveFrom > existing.effectiveFrom) {
      byCode.set(t.subProcessorCode, t);
    }
  }

  const now = Date.now();
  const expiryWarningMs = 30 * 24 * 60 * 60 * 1000;

  const rows: SubProcessorWithTia[] = subprocessors.map((s) => {
    const thirdCountry = isThirdCountry(s.jurisdiction);
    const tia = byCode.get(s.code) ?? null;
    let tiaState: SubProcessorWithTia["tiaState"];
    if (!thirdCountry) tiaState = "in-region";
    else if (!tia) tiaState = "missing";
    else if (tia.status === "REVOKED") tiaState = "revoked";
    else if (tia.status === "EXPIRED" || tia.effectiveTo.getTime() < now) tiaState = "expired";
    else if (tia.effectiveTo.getTime() - now < expiryWarningMs) tiaState = "expiring-soon";
    else tiaState = "covered";
    return { ...s, thirdCountry, tia, tiaState };
  });

  const uncovered = rows.filter(
    (r) => r.thirdCountry && (r.tiaState === "missing" || r.tiaState === "expired" || r.tiaState === "revoked"),
  );
  const expiringSoon = rows.filter((r) => r.tiaState === "expiring-soon");

  return {
    rows,
    tenantJurisdiction: tenant.jurisdiction,
    thirdCountryCount: rows.filter((r) => r.thirdCountry).length,
    uncovered,
    expiringSoon,
  };
}

/**
 * Activation gate. Returns `null` when the operator may proceed; returns
 * the offending sub-processors when activation must be blocked under §12.6.
 *
 * Wire this into surfaces that activate processing dependent on a specific
 * sub-processor (e.g. enabling a third-party Sales Identifier Partner that
 * would route data through a non-EU/UK processor). The function is generic
 * over an array of `subProcessorCode` strings the activation depends on.
 */
export async function transferGateOk(
  tenantId: string,
  requiredSubProcessorCodes: string[],
): Promise<{ ok: true } | { ok: false; missing: SubProcessor[] }> {
  if (requiredSubProcessorCodes.length === 0) return { ok: true };

  const subs = await superDb.subProcessor.findMany({
    where: { code: { in: requiredSubProcessorCodes }, isActive: true },
  });
  const tias = await tenantDb(tenantId).transferImpactAssessment.findMany({
    where: {
      tenantId,
      subProcessorCode: { in: requiredSubProcessorCodes },
      status: "RECORDED",
      effectiveTo: { gt: new Date() },
    },
  });
  const covered = new Set(tias.map((t) => t.subProcessorCode));

  const missing = subs.filter(
    (s) => isThirdCountry(s.jurisdiction) && !covered.has(s.code),
  );
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}

// ─── Mutations ────────────────────────────────────────────────────────────

export type RecordTiaInput = {
  tenantId: string;
  subProcessorCode: string;
  sccDocumentRef: string;
  tiaDocumentRef: string;
  signedByName: string;
  signedByRole: string;
  /** Optional override; defaults to today. */
  effectiveFrom?: Date;
  /** Optional override; defaults to effectiveFrom + 12 months. */
  effectiveTo?: Date;
  notes?: string | null;
  actorMembershipId: string;
};

export async function recordTia(input: RecordTiaInput): Promise<TransferImpactAssessment> {
  const sub = await superDb.subProcessor.findUnique({
    where: { code: input.subProcessorCode },
  });
  if (!sub) throw new Error(`tia: sub-processor ${input.subProcessorCode} not found`);
  if (!sub.isActive) throw new Error(`tia: sub-processor ${input.subProcessorCode} is inactive`);
  if (!isThirdCountry(sub.jurisdiction)) {
    throw new Error(
      `tia: sub-processor ${input.subProcessorCode} is in-region (${sub.jurisdiction}); TIA not required`,
    );
  }
  if (!input.sccDocumentRef.trim()) throw new Error("tia: SCC document reference is required");
  if (!input.tiaDocumentRef.trim()) throw new Error("tia: TIA document reference is required");
  if (!input.signedByName.trim()) throw new Error("tia: signedByName is required");
  if (!input.signedByRole.trim()) throw new Error("tia: signedByRole is required");

  const effectiveFrom = input.effectiveFrom ?? new Date();
  const effectiveTo =
    input.effectiveTo ??
    (() => {
      const d = new Date(effectiveFrom);
      d.setMonth(d.getMonth() + DEFAULT_TIA_VALIDITY_MONTHS);
      return d;
    })();

  // Mark any prior live TIA for the same (tenant, subprocessor) as revoked
  // so there is exactly one active record per pair.
  await tenantDb(input.tenantId).transferImpactAssessment.updateMany({
    where: {
      tenantId: input.tenantId,
      subProcessorCode: input.subProcessorCode,
      status: "RECORDED",
    },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason: "Superseded by new TIA record",
    },
  });

  const created = await tenantDb(input.tenantId).transferImpactAssessment.create({
    data: {
      tenantId: input.tenantId,
      subProcessorCode: input.subProcessorCode,
      status: "RECORDED",
      sccDocumentRef: input.sccDocumentRef.trim(),
      tiaDocumentRef: input.tiaDocumentRef.trim(),
      effectiveFrom,
      effectiveTo,
      signedByName: input.signedByName.trim(),
      signedByRole: input.signedByRole.trim(),
      dataCategories: sub.dataCategories,
      notes: input.notes?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TIA_RECORDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TransferImpactAssessment",
    subjectId: created.id,
    payload: {
      subProcessorCode: input.subProcessorCode,
      jurisdiction: sub.jurisdiction,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveTo: effectiveTo.toISOString(),
      signedByName: input.signedByName,
      signedByRole: input.signedByRole,
    },
  });

  return created;
}

export type RevokeTiaInput = {
  tenantId: string;
  tiaId: string;
  reason: string;
  actorMembershipId: string;
};

export async function revokeTia(input: RevokeTiaInput): Promise<TransferImpactAssessment> {
  if (!input.reason.trim()) throw new Error("tia: revoke reason is required");

  const tia = await tenantDb(input.tenantId).transferImpactAssessment.findFirst({
    where: { id: input.tiaId, tenantId: input.tenantId },
  });
  if (!tia) throw new Error("tia: not found");
  if (tia.status !== "RECORDED") {
    throw new Error(`tia: cannot revoke from status ${tia.status}`);
  }

  const updated = await tenantDb(input.tenantId).transferImpactAssessment.update({
    where: { id: tia.id },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason: input.reason.trim(),
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TIA_REVOKED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TransferImpactAssessment",
    subjectId: tia.id,
    payload: {
      subProcessorCode: tia.subProcessorCode,
      reason: input.reason,
    },
  });

  return updated;
}

/**
 * Cron sweep: flips RECORDED TIAs whose effectiveTo has passed to EXPIRED
 * and writes a TIA_EXPIRED audit event for each. Wired from the existing
 * lifecycle-sweep cron service so we don't take a second cron dependency.
 */
export async function expireOverdueTias(): Promise<{ expired: number }> {
  const overdue = await superDb.transferImpactAssessment.findMany({
    where: {
      status: "RECORDED",
      effectiveTo: { lte: new Date() },
    },
  });
  let expired = 0;
  for (const t of overdue) {
    await tenantDb(t.tenantId).transferImpactAssessment.update({
      where: { id: t.id },
      data: { status: "EXPIRED" },
    });
    await writeAuditEvent({
      tenantId: t.tenantId,
      eventType: "TIA_EXPIRED",
      actorMembershipId: null,
      subjectType: "TransferImpactAssessment",
      subjectId: t.id,
      payload: {
        subProcessorCode: t.subProcessorCode,
        effectiveTo: t.effectiveTo.toISOString(),
      },
    });
    expired += 1;
  }
  return { expired };
}

export const TIA_STATE_LABELS: Record<SubProcessorWithTia["tiaState"], string> = {
  "in-region": "In-region — no TIA required",
  covered: "TIA on file",
  "expiring-soon": "TIA expiring within 30 days",
  missing: "Third-country — TIA missing",
  expired: "TIA expired",
  revoked: "TIA revoked",
};

export type TransferGate = Awaited<ReturnType<typeof transferGateOk>>;
export type CrossBorderView = Awaited<ReturnType<typeof getCrossBorderView>>;

export type { TransferImpactAssessment } from "@prisma/client";
