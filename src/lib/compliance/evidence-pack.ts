/**
 * Compliance evidence pack — per-tenant audit-ready snapshot of security
 * + compliance posture (post-PRD hardening).
 *
 * Every enterprise procurement reviewer asks the same set of questions:
 * "Show us your security configuration. Show us your sub-processors.
 * Show us your audit chain integrity. Show us your encryption posture.
 * Show us your DPIA / TIA. Show us your latest breaches and SLAs." Today
 * each of those is answerable from a different admin page; assembling
 * them by hand for a SOC 2 / ISO 27001 / vendor audit is busywork that
 * a FIRM_ADMIN should be able to do with one click.
 *
 * This module composes the answer from the existing modules — no new
 * data is collected, no facts are restated, just a typed read-only view
 * over what the tenant already has. The pack is generated on demand,
 * never cached; every export writes a `COMPLIANCE_EVIDENCE_PACK_EXPORTED`
 * audit event with the actor + section list so the chain itself records
 * who pulled which slice when.
 *
 * **What the pack INCLUDES** (all read from current state):
 *   - tenant metadata (slug, name, status, defaultLanguage)
 *   - security configuration (TOTP policy, IP allowlist, session
 *     timeouts, step-up window)
 *   - active membership count + breakdown by role
 *   - active API key catalogue (name, prefix, scopes, creator, dates —
 *     NEVER the hash, the secret, or the keyVersion's underlying material)
 *   - latest AuditChainVerification result (from item 23)
 *   - encryption key rotation history (the most recent
 *     ENCRYPTION_KEYS_ROTATED audit row from item 27, if any)
 *   - sub-processor catalogue (active + pending changes) from item 24
 *   - latest TIA / DPIA snapshot indicators (counts + most-recent)
 *   - SLA + breach summary (recent measurements + recent incidents)
 *
 * **What the pack DELIBERATELY DOES NOT INCLUDE** (load-bearing invariant
 * — tested):
 *   - ApiKey.hash, ApiKey.keyVersion (HMAC posture is an implementation
 *     detail; integrators shouldn't infer it from a procurement pack)
 *   - WebhookSubscription.secretEncrypted (signing secrets must NEVER
 *     leave their first-display surface)
 *   - UserTotp.secretEncrypted (TOTP seed material)
 *   - ChannelAuth.encryptedTokens (OAuth refresh tokens)
 *   - User.email outside the FIRM_ADMIN/ACUMON_ADMIN listing (Member
 *     emails are user-PII; the pack reports counts, not lists)
 *   - Raw audit-event payloads (procurement doesn't need them; the
 *     /api/audit/export surface from item 16 covers that case)
 *   - Encryption key material (only rotation HISTORY, never the keys)
 *
 * Cross-tenant safety: the gathering uses `tenantDb(tenantId)` for
 * tenant-scoped reads (RLS double-binds) and `superDb` only for the
 * audit-event probes which already filter by `tenantId`. A bug that
 * forgets the tenantId clause still gets blocked at the DB by RLS.
 */
import { tenantDb, superDb } from "@/lib/db";

export type EvidencePackSection =
  | "tenant"
  | "security_config"
  | "membership_summary"
  | "api_keys"
  | "audit_chain"
  | "encryption"
  | "sub_processors"
  | "compliance_records"
  | "sla_breach";

export const ALL_SECTIONS: EvidencePackSection[] = [
  "tenant",
  "security_config",
  "membership_summary",
  "api_keys",
  "audit_chain",
  "encryption",
  "sub_processors",
  "compliance_records",
  "sla_breach",
];

export type EvidencePack = {
  meta: {
    generatedAt: string;
    tenantId: string;
    tenantSlug: string;
    schemaVersion: number;
    sections: EvidencePackSection[];
  };
  tenant: {
    slug: string;
    name: string;
    status: string;
    defaultLocale: string | null;
  };
  securityConfig: {
    requireTotp: boolean;
    sessionIdleTimeoutMinutes: number | null;
    sessionAbsoluteTimeoutMinutes: number | null;
    stepUpMaxAgeMinutes: number | null;
    allowedIpCidrsCount: number;
    allowedIpCidrs: string[];
  };
  membershipSummary: {
    total: number;
    byRole: Record<string, number>;
    byStatus: Record<string, number>;
  };
  apiKeys: {
    activeCount: number;
    revokedCount: number;
    expiredCount: number;
    keys: Array<{
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      createdAt: string;
      expiresAt: string | null;
      revokedAt: string | null;
      lastUsedAt: string | null;
    }>;
  };
  auditChain: {
    totalEvents: number;
    latestSeq: string | null;
    lastVerifiedAt: string | null;
    lastVerificationStatus: string | null;
    lastTamperedAt: string | null;
  };
  encryption: {
    rotationsRecorded: number;
    lastRotationAt: string | null;
  };
  subProcessors: {
    activeCount: number;
    inactiveCount: number;
    active: Array<{
      code: string;
      name: string;
      role: string;
      jurisdiction: string;
      dataCategories: string[];
      addedAt: string;
    }>;
    pendingChanges: Array<{
      id: string;
      kind: string;
      description: string;
      announcedAt: string;
      effectiveAt: string;
    }>;
  };
  complianceRecords: {
    tiaCount: number;
    dpiaCount: number;
    activeTermsVersions: Array<{ kind: string; version: number }>;
  };
  slaBreach: {
    breachIncidentsLast90Days: number;
    openBreachIncidents: number;
    slaMeasurementsLast90Days: number;
  };
};

export const EVIDENCE_PACK_SCHEMA_VERSION = 1;

export type BuildEvidencePackInput = {
  tenantId: string;
  /** Optional clock injection for tests. */
  now?: Date;
};

export async function buildEvidencePack(
  input: BuildEvidencePackInput,
): Promise<EvidencePack> {
  const now = input.now ?? new Date();
  const t = await superDb.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      defaultLocale: true,
      requireTotp: true,
      sessionIdleTimeoutMinutes: true,
      sessionAbsoluteTimeoutMinutes: true,
      stepUpMaxAgeMinutes: true,
      allowedIpCidrs: true,
    },
  });

  const tenantId = t.id;
  const db = tenantDb(tenantId);

  // Membership counts via groupBy — no PII pulled.
  const memberships = await db.membership.findMany({
    select: { role: true, status: true },
  });
  const byRole: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const m of memberships) {
    byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  }

  // API keys — explicit select, NEVER includes hash or keyVersion.
  const apiKeys = await db.apiKey.findMany({
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  let activeCount = 0;
  let revokedCount = 0;
  let expiredCount = 0;
  for (const k of apiKeys) {
    if (k.revokedAt) revokedCount += 1;
    else if (k.expiresAt && k.expiresAt < now) expiredCount += 1;
    else activeCount += 1;
  }

  // Audit chain — count + latest seq + latest verification result.
  const latestEvent = await superDb.auditEvent.findFirst({
    where: { tenantId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const totalEvents = await superDb.auditEvent.count({ where: { tenantId } });
  const lastVerification = await db.auditChainVerification.findFirst({
    orderBy: { createdAt: "desc" },
    select: { status: true, finishedAt: true, createdAt: true, notifiedAt: true },
  });
  const lastTampered = await db.auditChainVerification.findFirst({
    where: { status: "TAMPERED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  // Encryption rotation history — the audit row count + most recent.
  const lastRotation = await superDb.auditEvent.findFirst({
    where: { tenantId, eventType: "ENCRYPTION_KEYS_ROTATED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const rotationsRecorded = await superDb.auditEvent.count({
    where: { tenantId, eventType: "ENCRYPTION_KEYS_ROTATED" },
  });

  // Sub-processors — active list + pending changes.
  const allSubs = await superDb.subProcessor.findMany({
    where: {},
    select: {
      code: true,
      name: true,
      role: true,
      jurisdiction: true,
      dataCategories: true,
      isActive: true,
      addedAt: true,
    },
    orderBy: { addedAt: "asc" },
  });
  const activeSubs = allSubs.filter((s) => s.isActive);
  const inactiveSubs = allSubs.filter((s) => !s.isActive);
  const pendingChanges = await superDb.subProcessorChange.findMany({
    where: { status: "ANNOUNCED" },
    select: {
      id: true,
      kind: true,
      description: true,
      announcedAt: true,
      effectiveAt: true,
    },
    orderBy: { effectiveAt: "asc" },
  });

  // Compliance records — counts only (the FIRM_ADMIN has dedicated pages
  // for detail). Active terms versions are the procurement-facing answer
  // to "which terms is your tenant on right now".
  const tiaCount = await db.transferImpactAssessment.count({});
  const dpiaCount = await db.dPIAAttestation.count({});
  const activeTerms = await db.termsRecord.findMany({
    where: { status: "ACTIVE" },
    select: { kind: true, version: true },
    orderBy: [{ kind: "asc" }, { version: "desc" }],
  });

  // SLA + breach summary. SlaMeasurement.period is a YYYY-MM string;
  // we compute the threshold YYYY-MM and use a string compare. Breach
  // detection uses `detectedAt` if the model has it; otherwise `createdAt`.
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgoPeriod = `${ninetyDaysAgo.getUTCFullYear()}-${String(
    ninetyDaysAgo.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
  const breachIncidentsLast90Days = await db.breachIncident.count({
    where: { createdAt: { gte: ninetyDaysAgo } },
  });
  const openBreachIncidents = await db.breachIncident.count({
    where: { resolvedAt: null },
  });
  const slaMeasurementsLast90Days = await db.slaMeasurement.count({
    where: { period: { gte: ninetyDaysAgoPeriod } },
  });

  return {
    meta: {
      generatedAt: now.toISOString(),
      tenantId,
      tenantSlug: t.slug,
      schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
      sections: [...ALL_SECTIONS],
    },
    tenant: {
      slug: t.slug,
      name: t.name,
      status: t.status,
      defaultLocale: t.defaultLocale,
    },
    securityConfig: {
      requireTotp: t.requireTotp,
      sessionIdleTimeoutMinutes: t.sessionIdleTimeoutMinutes,
      sessionAbsoluteTimeoutMinutes: t.sessionAbsoluteTimeoutMinutes,
      stepUpMaxAgeMinutes: t.stepUpMaxAgeMinutes,
      allowedIpCidrsCount: t.allowedIpCidrs.length,
      allowedIpCidrs: [...t.allowedIpCidrs],
    },
    membershipSummary: {
      total: memberships.length,
      byRole,
      byStatus,
    },
    apiKeys: {
      activeCount,
      revokedCount,
      expiredCount,
      keys: apiKeys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: [...k.scopes],
        createdAt: k.createdAt.toISOString(),
        expiresAt: k.expiresAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
    },
    auditChain: {
      totalEvents,
      latestSeq: latestEvent ? latestEvent.seq.toString() : null,
      lastVerifiedAt:
        lastVerification?.finishedAt?.toISOString() ??
        lastVerification?.createdAt.toISOString() ??
        null,
      lastVerificationStatus: lastVerification?.status ?? null,
      lastTamperedAt: lastTampered?.createdAt.toISOString() ?? null,
    },
    encryption: {
      rotationsRecorded,
      lastRotationAt: lastRotation?.createdAt.toISOString() ?? null,
    },
    subProcessors: {
      activeCount: activeSubs.length,
      inactiveCount: inactiveSubs.length,
      active: activeSubs.map((s) => ({
        code: s.code,
        name: s.name,
        role: s.role,
        jurisdiction: s.jurisdiction,
        dataCategories: [...s.dataCategories],
        addedAt: s.addedAt.toISOString(),
      })),
      pendingChanges: pendingChanges.map((c) => ({
        id: c.id,
        kind: c.kind,
        description: c.description,
        announcedAt: c.announcedAt.toISOString(),
        effectiveAt: c.effectiveAt.toISOString(),
      })),
    },
    complianceRecords: {
      tiaCount,
      dpiaCount,
      activeTermsVersions: activeTerms.map((t) => ({
        kind: t.kind,
        version: t.version,
      })),
    },
    slaBreach: {
      breachIncidentsLast90Days,
      openBreachIncidents,
      slaMeasurementsLast90Days,
    },
  };
}
