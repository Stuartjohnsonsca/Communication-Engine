import type { OnboardingPhase, Tenant } from "@prisma/client";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §14.1 Client Onboarding.
 *
 * The PRD enumerates six phases:
 *   1. Commercial — Order Form, DPA, optional addenda (SI, XCL, BYOK).
 *   2. Technical — tenant provisioning, jurisdiction, SSO, sub-processor list.
 *   3. Compliance — DPIA Helper completion + DPO attestation.
 *   4. Configuration — FCT appointment, FIRM_ADMIN appointment, FCG scan + approval.
 *   5. Pilot — Sandbox / dry-run with a limited User cohort.
 *   6. Production — phased rollout to remaining Users.
 *
 * Many of these can be detected from existing data (DPIA attestations,
 * FCG.status = COMMITTED, the parent tenant having a sandbox child, etc.).
 * The remainder are signed off manually via `OnboardingChecklistItem`.
 *
 * The page combines both into one consolidated checklist.
 */

export type OnboardingStepDef = {
  /** Stable code, used for the per-tenant tick row + audit payload. */
  code: string;
  phase: OnboardingPhase;
  title: string;
  /** Short hint shown under the title. */
  detail: string;
  /** Detection: when the platform can determine completeness from data alone. */
  detect?: (signals: OnboardingSignals) => boolean;
  /** Helpful link in the UI (relative to /[tenantSlug]). */
  href?: string;
};

export type OnboardingSignals = {
  tenant: Tenant;
  termsKinds: Set<string>;
  hasDpiaAttested: boolean;
  hasActiveFcg: boolean;
  fctMemberCount: number;
  firmAdminCount: number;
  hasActiveChannel: boolean;
  hasSandbox: boolean;
  pilotMemberCount: number;
  productionMemberCount: number;
};

export const ONBOARDING_STEPS: OnboardingStepDef[] = [
  // 1. Commercial -----------------------------------------------------------
  {
    code: "commercial.order-form",
    phase: "COMMERCIAL",
    title: "Order Form executed",
    detail: "Acumon countersigned and dated.",
  },
  {
    code: "commercial.msa-active",
    phase: "COMMERCIAL",
    title: "Master Services Agreement active",
    detail: "MSA with status = ACTIVE in /admin/terms.",
    href: "/admin/terms",
    detect: (s) => s.termsKinds.has("MSA"),
  },
  {
    code: "commercial.dpa-active",
    phase: "COMMERCIAL",
    title: "Data Processing Agreement active",
    detail: "DPA with status = ACTIVE in /admin/terms.",
    href: "/admin/terms",
    detect: (s) => s.termsKinds.has("DPA"),
  },
  {
    code: "commercial.addenda",
    phase: "COMMERCIAL",
    title: "Optional addenda decided",
    detail:
      "Sales Identifier / Cross-Client Learning / BYOK addenda either signed or explicitly declined.",
  },

  // 2. Technical ------------------------------------------------------------
  {
    code: "technical.tenant-provisioned",
    phase: "TECHNICAL",
    title: "Tenant provisioned",
    detail: "Tenant exists in the platform with a status other than PROVISIONING.",
    detect: (s) => s.tenant.status !== "PROVISIONING",
  },
  {
    code: "technical.jurisdiction",
    phase: "TECHNICAL",
    title: "Jurisdiction selected",
    detail: "Tenant.jurisdiction set (UK / EU-IE / EU-DE / EU-FR).",
    detect: (s) => !!s.tenant.jurisdiction,
  },
  {
    code: "technical.sso-configured",
    phase: "TECHNICAL",
    title: "SSO configured",
    detail: "SAML 2.0 / OIDC active. Required for FIRM_ADMIN + FCT_MEMBER MFA.",
  },
  {
    code: "technical.subprocessors-accepted",
    phase: "TECHNICAL",
    title: "Sub-processor list accepted",
    detail: "Client confirms /switching list (PRD §15.3) before activation.",
    href: "/switching",
  },
  {
    code: "technical.first-channel",
    phase: "TECHNICAL",
    title: "At least one channel authorised",
    detail: "OAuth completed for one Tier-1 source (M365 / Google / Slack).",
    href: "/admin/channels",
    detect: (s) => s.hasActiveChannel,
  },

  // 3. Compliance -----------------------------------------------------------
  {
    code: "compliance.dpia-attested",
    phase: "COMPLIANCE",
    title: "DPIA attested by Client DPO",
    detail: "PRD §12.2 — at least one DPIAAttestation row on file.",
    href: "/dpia",
    detect: (s) => s.hasDpiaAttested,
  },
  {
    code: "compliance.processing-map",
    phase: "COMPLIANCE",
    title: "Controller/Processor map walked through",
    detail: "PRD §12.1 — Client confirms which rows apply.",
    href: "/compliance/processing-map",
  },
  {
    code: "compliance.transfers",
    phase: "COMPLIANCE",
    title: "Cross-border transfer position recorded",
    detail: "Either no third-country processors, or all third-country with TIA + SCC on file.",
    href: "/compliance/transfers",
  },

  // 4. Configuration --------------------------------------------------------
  {
    code: "configuration.firm-admin",
    phase: "CONFIGURATION",
    title: "Firm Administrator appointed",
    detail: "≥ 1 active membership with role = FIRM_ADMIN.",
    href: "/admin/members",
    detect: (s) => s.firmAdminCount >= 1,
  },
  {
    code: "configuration.fct-appointed",
    phase: "CONFIGURATION",
    title: "Firm Culture Team appointed",
    detail: "≥ 3 active FCT members so quorum is meaningful.",
    href: "/admin/members",
    detect: (s) => s.fctMemberCount >= 3,
  },
  {
    code: "configuration.fcg-scan",
    phase: "CONFIGURATION",
    title: "Firm Culture Scan run",
    detail: "Initial bounded scan completed via /fcg/scan.",
    href: "/fcg/scan",
  },
  {
    code: "configuration.fcg-approved",
    phase: "CONFIGURATION",
    title: "Firm Culture Guide approved",
    detail: "≥ 1 FCG with status = COMMITTED — quorum vote passed.",
    href: "/fcg",
    detect: (s) => s.hasActiveFcg,
  },

  // 5. Pilot ----------------------------------------------------------------
  {
    code: "pilot.sandbox-provisioned",
    phase: "PILOT",
    title: "Sandbox tenant provisioned",
    detail: "PRD §14.2 — child tenant created with cohort + close date.",
    href: "/admin/sandbox",
    detect: (s) => s.hasSandbox,
  },
  {
    code: "pilot.cohort-onboarded",
    phase: "PILOT",
    title: "Pilot cohort onboarded",
    detail: "Up to 10 pilot Users authorised channels in the sandbox.",
    href: "/admin/sandbox",
  },
  {
    code: "pilot.outcome-recorded",
    phase: "PILOT",
    title: "Sandbox outcome recorded",
    detail: "PROMOTED / ITERATING / DECLINED captured before exit.",
    href: "/admin/sandbox",
  },

  // 6. Production -----------------------------------------------------------
  {
    code: "production.phased-rollout",
    phase: "PRODUCTION",
    title: "Phased rollout plan recorded",
    detail: "Internal plan documenting the rollout stages.",
  },
  {
    code: "production.users-onboarded",
    phase: "PRODUCTION",
    title: "Remaining Users onboarded",
    detail: "Active membership count in production tenant ≥ 80% of headcount.",
    href: "/admin/lifecycle",
  },
  {
    code: "production.go-live",
    phase: "PRODUCTION",
    title: "Production go-live",
    detail: "Client signs off go-live. Onboarding flips to LIVE.",
  },
];

const PHASE_ORDER: OnboardingPhase[] = [
  "COMMERCIAL",
  "TECHNICAL",
  "COMPLIANCE",
  "CONFIGURATION",
  "PILOT",
  "PRODUCTION",
  "LIVE",
];

export const PHASE_LABELS: Record<OnboardingPhase, string> = {
  COMMERCIAL: "1. Commercial",
  TECHNICAL: "2. Technical",
  COMPLIANCE: "3. Compliance",
  CONFIGURATION: "4. Configuration",
  PILOT: "5. Pilot",
  PRODUCTION: "6. Production",
  LIVE: "Live",
};

export type ResolvedStep = OnboardingStepDef & {
  done: boolean;
  source: "detected" | "manual" | "open";
  manualCheckedAt?: Date;
  manualCheckedByName?: string;
  notes?: string;
};

export type OnboardingState = {
  tenant: Tenant;
  steps: ResolvedStep[];
  byPhase: Record<OnboardingPhase, ResolvedStep[]>;
  currentPhase: OnboardingPhase;
  progressPct: number;
  signals: OnboardingSignals;
};

export async function getOnboardingState(tenant: Tenant): Promise<OnboardingState> {
  const signals = await collectSignals(tenant);
  const items = await tenantDb(tenant.id).onboardingChecklistItem.findMany({
    where: { tenantId: tenant.id },
  });
  const byCode = new Map(items.map((i) => [i.code, i]));

  const steps: ResolvedStep[] = ONBOARDING_STEPS.map((def) => {
    const detected = def.detect ? def.detect(signals) : false;
    const item = byCode.get(def.code);
    const manuallyTicked = !!item?.checked;
    const done = detected || manuallyTicked;
    return {
      ...def,
      done,
      source: detected ? "detected" : manuallyTicked ? "manual" : "open",
      manualCheckedAt: item?.checkedAt ?? undefined,
      manualCheckedByName: item?.checkedByName ?? undefined,
      notes: item?.notes ?? undefined,
    };
  });

  const byPhase = {
    COMMERCIAL: [],
    TECHNICAL: [],
    COMPLIANCE: [],
    CONFIGURATION: [],
    PILOT: [],
    PRODUCTION: [],
    LIVE: [],
  } as Record<OnboardingPhase, ResolvedStep[]>;
  for (const s of steps) byPhase[s.phase].push(s);

  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const progressPct = total === 0 ? 100 : Math.round((done / total) * 100);

  return {
    tenant,
    steps,
    byPhase,
    currentPhase: tenant.onboardingPhase,
    progressPct,
    signals,
  };
}

async function collectSignals(tenant: Tenant): Promise<OnboardingSignals> {
  const [
    activeTerms,
    dpiaCount,
    fcgCommitted,
    fctCount,
    firmAdminCount,
    activeChannel,
    sandbox,
    activeMembershipCount,
  ] = await Promise.all([
    tenantDb(tenant.id).termsRecord.findMany({
      where: { tenantId: tenant.id, status: "ACTIVE" },
      select: { kind: true },
    }),
    tenantDb(tenant.id).dPIAAttestation.count({ where: { tenantId: tenant.id } }),
    tenantDb(tenant.id).firmCultureGuide.count({
      where: { tenantId: tenant.id, status: "COMMITTED" },
    }),
    tenantDb(tenant.id).membership.count({
      where: { tenantId: tenant.id, role: "FCT_MEMBER", status: "ACTIVE" },
    }),
    tenantDb(tenant.id).membership.count({
      where: { tenantId: tenant.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    }),
    tenantDb(tenant.id).channel.count({
      where: { tenantId: tenant.id, status: "ACTIVE" },
    }),
    superDb.tenant.findFirst({
      where: { parentTenantId: tenant.id, isSandbox: true },
      select: { id: true },
    }),
    tenantDb(tenant.id).membership.count({
      where: { tenantId: tenant.id, status: "ACTIVE" },
    }),
  ]);

  return {
    tenant,
    termsKinds: new Set(activeTerms.map((t) => t.kind)),
    hasDpiaAttested: dpiaCount > 0,
    hasActiveFcg: fcgCommitted > 0,
    fctMemberCount: fctCount,
    firmAdminCount,
    hasActiveChannel: activeChannel > 0,
    hasSandbox: !!sandbox,
    pilotMemberCount: 0,
    productionMemberCount: activeMembershipCount,
  };
}

// ─── Mutations ────────────────────────────────────────────────────────────

export async function tickStep(input: {
  tenantId: string;
  code: string;
  checked: boolean;
  checkedByName: string;
  notes?: string | null;
  actorMembershipId: string;
}) {
  const def = ONBOARDING_STEPS.find((s) => s.code === input.code);
  if (!def) throw new Error(`onboarding: unknown step ${input.code}`);
  if (input.checked && !input.checkedByName.trim()) {
    throw new Error("onboarding: checkedByName required");
  }

  const upserted = await tenantDb(input.tenantId).onboardingChecklistItem.upsert({
    where: {
      tenantId_code: { tenantId: input.tenantId, code: input.code },
    },
    create: {
      tenantId: input.tenantId,
      phase: def.phase,
      code: input.code,
      checked: input.checked,
      checkedAt: input.checked ? new Date() : null,
      checkedByName: input.checked ? input.checkedByName.trim() : null,
      notes: input.notes?.trim() || null,
    },
    update: {
      checked: input.checked,
      checkedAt: input.checked ? new Date() : null,
      checkedByName: input.checked ? input.checkedByName.trim() : null,
      notes: input.notes?.trim() ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: input.checked ? "ONBOARDING_STEP_TICKED" : "ONBOARDING_STEP_UNTICKED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "OnboardingChecklistItem",
    subjectId: upserted.id,
    payload: {
      code: input.code,
      phase: def.phase,
      checkedByName: input.checked ? input.checkedByName : null,
    },
  });

  return upserted;
}

export async function setOnboardingPhase(input: {
  tenantId: string;
  phase: OnboardingPhase;
  actorMembershipId: string;
}) {
  const before = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { onboardingPhase: true, onboardingStartedAt: true },
  });
  if (!before) throw new Error("tenant not found");
  if (before.onboardingPhase === input.phase) return;

  const data: { onboardingPhase: OnboardingPhase; onboardingStartedAt?: Date; onboardingCompletedAt?: Date | null } = {
    onboardingPhase: input.phase,
  };
  if (!before.onboardingStartedAt && input.phase !== "COMMERCIAL") {
    data.onboardingStartedAt = new Date();
  }
  if (input.phase === "LIVE") {
    data.onboardingCompletedAt = new Date();
  } else {
    data.onboardingCompletedAt = null;
  }

  await superDb.tenant.update({ where: { id: input.tenantId }, data });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: input.phase === "LIVE" ? "ONBOARDING_COMPLETED" : "ONBOARDING_PHASE_CHANGED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: { from: before.onboardingPhase, to: input.phase },
  });
}

export function nextPhase(current: OnboardingPhase): OnboardingPhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}

export function prevPhase(current: OnboardingPhase): OnboardingPhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx <= 0) return null;
  return PHASE_ORDER[idx - 1];
}

export const PHASES_IN_ORDER = PHASE_ORDER;
