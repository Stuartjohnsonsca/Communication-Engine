import type { Prisma, ProcessingActivity, Tenant } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §12.1 Controller / Processor Map.
 *
 * Published, product-wide table — every Client and prospective Client sees
 * the same rows. Per-tenant applicability is computed at read time from
 * tenant flags (Sales Identifier on/off, XCL opt-in, voice authorised,
 * partner type) so two tenants with different feature footprints get a
 * tailored view of which rows are active for them, without storing the
 * applicability per tenant.
 *
 * Same global-data pattern as Roadmap, Risks, Sub-Processors, Integrations:
 *   - no tenantId, NOT under RLS
 *   - read = `processing-map:read` (FCT + FIRM_ADMIN; governance-grade)
 *   - manage = `processing-map:manage` AND `tenant.slug === "acumon"`
 *   - audit events on the operator's tenant chain
 */

const ACUMON_TENANT_SLUG = "acumon";

export type ProcessingActivityWithApplicability = ProcessingActivity & {
  applies: boolean;
  applicabilityReason: string;
};

export async function getProcessingMap(
  tenant: Tenant,
): Promise<{
  rows: ProcessingActivityWithApplicability[];
  activeCount: number;
  notApplicableCount: number;
}> {
  const all = await superDb.processingActivity.findMany({
    orderBy: { ordinal: "asc" },
  });
  const voiceAuthorised = await tenantHasVoiceChannel(tenant.id);
  const ssoConfigured = await tenantHasSSO(tenant.id);

  const rows = all.map((activity) =>
    decorateApplicability(activity, tenant, { voiceAuthorised, ssoConfigured }),
  );
  return {
    rows,
    activeCount: rows.filter((r) => r.applies).length,
    notApplicableCount: rows.filter((r) => !r.applies).length,
  };
}

function decorateApplicability(
  activity: ProcessingActivity,
  tenant: Tenant,
  derived: { voiceAuthorised: boolean; ssoConfigured: boolean },
): ProcessingActivityWithApplicability {
  switch (activity.applicabilityFlag) {
    case "salesIdentifierEnabled":
      return {
        ...activity,
        applies: tenant.salesIdentifierEnabled,
        applicabilityReason: tenant.salesIdentifierEnabled
          ? "Sales Identifier is enabled for this tenant"
          : "Sales Identifier is disabled — activity not active",
      };
    case "salesIdentifierThirdParty":
      // §8.3 — Partner default is Acumon. Joint controllership only kicks in
      // when the Client has switched to a third-party Partner. We model this
      // as `salesIdentifierEnabled && !pricingSalesIdPartnerDefault`.
      {
        const thirdParty =
          tenant.salesIdentifierEnabled && !tenant.pricingSalesIdPartnerDefault;
        return {
          ...activity,
          applies: thirdParty,
          applicabilityReason: thirdParty
            ? "Sales Identifier Partner is a third party — joint controllership applies"
            : tenant.salesIdentifierEnabled
              ? "SI Partner is the Acumon default — joint controllership not engaged"
              : "Sales Identifier disabled",
        };
      }
    case "crossClientLearningOptedIn":
      return {
        ...activity,
        applies: tenant.pricingCrossClientLearningOptIn,
        applicabilityReason: tenant.pricingCrossClientLearningOptIn
          ? "Cross-Client Learning opt-in is on — Acumon acts as independent controller"
          : "Cross-Client Learning is off — no XCL processing in this tenant",
      };
    case "voiceAuthorised":
      return {
        ...activity,
        applies: derived.voiceAuthorised,
        applicabilityReason: derived.voiceAuthorised
          ? "Voice channel authorised in this tenant"
          : "No active voice channel — transcription not engaged",
      };
    case "ssoConfigured":
      return {
        ...activity,
        applies: derived.ssoConfigured,
        applicabilityReason: derived.ssoConfigured
          ? "SAML / OIDC SSO configured"
          : "Email-link auth only — no identity sub-processor engaged",
      };
    case "always":
    default:
      return {
        ...activity,
        applies: true,
        applicabilityReason: "Always applies for every Client",
      };
  }
}

async function tenantHasVoiceChannel(tenantId: string): Promise<boolean> {
  // Voice is delivered through Channel.kind = TEAMS / ZOOM / MEET when
  // transcription is in scope. PRD §13.5 voice transcription is gated on
  // a sub-processor in-region commitment, but for the purpose of the
  // Controller / Processor map we treat any active meeting-platform channel
  // as the activation flag.
  const c = await superDb.channel.count({
    where: {
      tenantId,
      kind: { in: ["TEAMS", "ZOOM", "MEET"] },
      status: "ACTIVE",
    },
  });
  return c > 0;
}

async function tenantHasSSO(tenantId: string): Promise<boolean> {
  // Channel.kind isn't the right signal for SSO; the production wiring is
  // tracked on `Channel.kind = SAML | OIDC` once the provider lands. Until
  // then, treat the flag as "configured" if any active Channel is using
  // an SSO-flavoured mechanism. For v1 we read it from a sentinel kind.
  const c = await superDb.channel.count({
    where: {
      tenantId,
      kind: { in: ["SAML", "OIDC"] },
      status: "ACTIVE",
    },
  });
  return c > 0;
}

// ─── Mutations ────────────────────────────────────────────────────────────

export type AddProcessingActivityInput = {
  code: string;
  label: string;
  controller: string;
  processor: string;
  lawfulBasis?: string | null;
  contract?: string | null;
  processesPersonal?: boolean;
  processesSpecial?: boolean;
  applicabilityFlag?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function addProcessingActivity(
  input: AddProcessingActivityInput,
): Promise<ProcessingActivity> {
  const code = input.code.trim().toLowerCase();
  if (!code) throw new Error("processing-activity: code is required");
  if (!/^[a-z0-9_-]+$/.test(code)) {
    throw new Error("processing-activity: code must be lowercase alphanumeric with - or _");
  }
  if (!input.label.trim()) throw new Error("processing-activity: label is required");
  if (!input.controller.trim()) throw new Error("processing-activity: controller is required");
  if (!input.processor.trim()) throw new Error("processing-activity: processor is required");

  const existing = await superDb.processingActivity.findUnique({ where: { code } });
  if (existing) throw new Error(`processing-activity: code ${code} already exists`);

  const max = await superDb.processingActivity.aggregate({ _max: { ordinal: true } });
  const ordinal = (max._max.ordinal ?? -1) + 1;

  const created = await superDb.processingActivity.create({
    data: {
      code,
      ordinal,
      label: input.label.trim(),
      controller: input.controller.trim(),
      processor: input.processor.trim(),
      lawfulBasis: input.lawfulBasis?.trim() || null,
      contract: input.contract?.trim() || null,
      processesPersonal: input.processesPersonal ?? true,
      processesSpecial: input.processesSpecial ?? false,
      applicabilityFlag: input.applicabilityFlag?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "PROCESSING_ACTIVITY_ADDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ProcessingActivity",
    subjectId: created.id,
    payload: {
      code,
      label: created.label,
      controller: created.controller,
      processor: created.processor,
    },
  });

  return created;
}

export type UpdateProcessingActivityInput = {
  code: string;
  label?: string;
  controller?: string;
  processor?: string;
  lawfulBasis?: string | null;
  contract?: string | null;
  processesPersonal?: boolean;
  processesSpecial?: boolean;
  applicabilityFlag?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updateProcessingActivity(
  input: UpdateProcessingActivityInput,
): Promise<ProcessingActivity> {
  const before = await superDb.processingActivity.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`processing-activity: ${input.code} not found`);

  const data: Prisma.ProcessingActivityUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.label !== undefined && input.label.trim() && input.label.trim() !== before.label) {
    data.label = input.label.trim();
    changes.label = { from: before.label, to: data.label };
  }
  if (input.controller !== undefined && input.controller.trim() && input.controller.trim() !== before.controller) {
    data.controller = input.controller.trim();
    changes.controller = { from: before.controller, to: data.controller };
  }
  if (input.processor !== undefined && input.processor.trim() && input.processor.trim() !== before.processor) {
    data.processor = input.processor.trim();
    changes.processor = { from: before.processor, to: data.processor };
  }
  if (input.lawfulBasis !== undefined) {
    const next = input.lawfulBasis?.trim() || null;
    if (next !== before.lawfulBasis) {
      data.lawfulBasis = next;
      changes.lawfulBasis = { from: before.lawfulBasis, to: next };
    }
  }
  if (input.contract !== undefined) {
    const next = input.contract?.trim() || null;
    if (next !== before.contract) {
      data.contract = next;
      changes.contract = { from: before.contract, to: next };
    }
  }
  if (input.processesPersonal !== undefined && input.processesPersonal !== before.processesPersonal) {
    data.processesPersonal = input.processesPersonal;
    changes.processesPersonal = { from: before.processesPersonal, to: input.processesPersonal };
  }
  if (input.processesSpecial !== undefined && input.processesSpecial !== before.processesSpecial) {
    data.processesSpecial = input.processesSpecial;
    changes.processesSpecial = { from: before.processesSpecial, to: input.processesSpecial };
  }
  if (input.applicabilityFlag !== undefined) {
    const next = input.applicabilityFlag?.trim() || null;
    if (next !== before.applicabilityFlag) {
      data.applicabilityFlag = next;
      changes.applicabilityFlag = { from: before.applicabilityFlag, to: next };
    }
  }
  if (input.notes !== undefined) {
    const next = input.notes?.trim() || null;
    if (next !== before.notes) {
      data.notes = next;
      changes.notes = { from: before.notes, to: next };
    }
  }

  if (Object.keys(changes).length === 0) return before;

  const updated = await superDb.processingActivity.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "PROCESSING_ACTIVITY_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ProcessingActivity",
    subjectId: before.id,
    payload: { code: before.code, changes: changes as Prisma.InputJsonValue },
  });

  return updated;
}

export function isAcumonComplianceOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}

export const APPLICABILITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "always", label: "Always — every Client" },
  { value: "salesIdentifierEnabled", label: "Sales Identifier on" },
  { value: "salesIdentifierThirdParty", label: "Sales Identifier Partner = third party" },
  { value: "crossClientLearningOptedIn", label: "Cross-Client Learning opt-in" },
  { value: "voiceAuthorised", label: "Voice channel authorised" },
  { value: "ssoConfigured", label: "SAML / OIDC SSO configured" },
];
