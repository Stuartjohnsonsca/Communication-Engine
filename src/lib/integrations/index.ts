import type {
  IntegrationCategory,
  IntegrationStatus,
  IntegrationTarget,
  IntegrationTier,
  Prisma,
} from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Integration Tiers (PRD §10).
 *
 * Acumon publishes the integrations catalogue in advance of contracting per
 * §15.3, so prospective and current Clients see the same list. Tier 1 must
 * be live at GA; Tier 2 is committed for delivery within 6 months of GA;
 * Tier 3 is roadmap; SDK is the generic extensibility commitment from §10.4.
 *
 * Same global-data pattern as Roadmap, Risks, and Sub-Processors:
 *   - no tenantId, NOT under RLS
 *   - read is universal (`integrations:read`)
 *   - mutations are gated to FIRM_ADMIN/ACUMON_ADMIN AND additionally
 *     to `tenant.slug === "acumon"` in the page handler
 *   - audit events are written against the operator's tenant chain
 */

const ACUMON_TENANT_SLUG = "acumon";

export type IntegrationsView = {
  tier1: IntegrationTarget[];
  tier2: IntegrationTarget[];
  tier3: IntegrationTarget[];
  sdk: IntegrationTarget[];
  /** Total live (AVAILABLE) integration targets, excluding deprecated. */
  liveCount: number;
  /** Targets the §15.3 export schema needs to declare per category. */
  byCategory: Map<IntegrationCategory, IntegrationTarget[]>;
};

export async function getIntegrationsView(): Promise<IntegrationsView> {
  const all = await superDb.integrationTarget.findMany({
    orderBy: [{ tier: "asc" }, { ordinal: "asc" }],
  });
  const byCategory = new Map<IntegrationCategory, IntegrationTarget[]>();
  for (const t of all) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  return {
    tier1: all.filter((t) => t.tier === "TIER_1"),
    tier2: all.filter((t) => t.tier === "TIER_2"),
    tier3: all.filter((t) => t.tier === "TIER_3"),
    sdk: all.filter((t) => t.tier === "SDK"),
    liveCount: all.filter((t) => t.status === "AVAILABLE").length,
    byCategory,
  };
}

export async function getIntegrationByCode(code: string): Promise<IntegrationTarget | null> {
  return superDb.integrationTarget.findUnique({ where: { code } });
}

// ─── Mutations ────────────────────────────────────────────────────────────

export type AddIntegrationInput = {
  code: string;
  name: string;
  vendor?: string | null;
  tier: IntegrationTier;
  category: IntegrationCategory;
  status?: IntegrationStatus;
  channelKind?: string | null;
  authMechanism?: string;
  requiredScopes?: string[];
  capabilities?: string[];
  role?: string | null;
  notes?: string | null;
  /** Operator's tenant — for audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function addIntegrationTarget(input: AddIntegrationInput): Promise<IntegrationTarget> {
  const code = input.code.trim().toLowerCase();
  if (!code) throw new Error("integration: code is required");
  if (!/^[a-z0-9_-]+$/.test(code)) {
    throw new Error("integration: code must be lowercase alphanumeric with - or _");
  }
  if (!input.name.trim()) throw new Error("integration: name is required");

  const existing = await superDb.integrationTarget.findUnique({ where: { code } });
  if (existing) throw new Error(`integration: code ${code} already exists`);

  // Place new entries at the end of the ordinal sequence within the tier.
  // Adding 100 per tier so manual reordering by editing ordinal is feasible.
  const max = await superDb.integrationTarget.aggregate({
    _max: { ordinal: true },
    where: { tier: input.tier },
  });
  const ordinal = (max._max.ordinal ?? -1) + 1;

  const created = await superDb.integrationTarget.create({
    data: {
      code,
      ordinal,
      name: input.name.trim(),
      vendor: input.vendor?.trim() || null,
      tier: input.tier,
      category: input.category,
      status: input.status ?? "PLANNED",
      channelKind: input.channelKind?.trim() || null,
      authMechanism: input.authMechanism?.trim() || "oauth2",
      requiredScopes: cleanStringArray(input.requiredScopes),
      capabilities: cleanStringArray(input.capabilities),
      role: input.role?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "INTEGRATION_TARGET_ADDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "IntegrationTarget",
    subjectId: created.id,
    payload: {
      code,
      name: created.name,
      tier: created.tier,
      category: created.category,
      status: created.status,
    },
  });

  return created;
}

export type UpdateIntegrationInput = {
  code: string;
  name?: string;
  vendor?: string | null;
  tier?: IntegrationTier;
  category?: IntegrationCategory;
  channelKind?: string | null;
  authMechanism?: string;
  requiredScopes?: string[];
  capabilities?: string[];
  role?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updateIntegrationTarget(
  input: UpdateIntegrationInput,
): Promise<IntegrationTarget> {
  const before = await superDb.integrationTarget.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`integration: ${input.code} not found`);

  const data: Prisma.IntegrationTargetUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.name !== undefined && input.name.trim() && input.name.trim() !== before.name) {
    data.name = input.name.trim();
    changes.name = { from: before.name, to: data.name };
  }
  if (input.vendor !== undefined) {
    const next = input.vendor?.trim() || null;
    if (next !== before.vendor) {
      data.vendor = next;
      changes.vendor = { from: before.vendor, to: next };
    }
  }
  if (input.tier !== undefined && input.tier !== before.tier) {
    data.tier = input.tier;
    changes.tier = { from: before.tier, to: input.tier };
  }
  if (input.category !== undefined && input.category !== before.category) {
    data.category = input.category;
    changes.category = { from: before.category, to: input.category };
  }
  if (input.channelKind !== undefined) {
    const next = input.channelKind?.trim() || null;
    if (next !== before.channelKind) {
      data.channelKind = next;
      changes.channelKind = { from: before.channelKind, to: next };
    }
  }
  if (input.authMechanism !== undefined && input.authMechanism.trim()) {
    const next = input.authMechanism.trim();
    if (next !== before.authMechanism) {
      data.authMechanism = next;
      changes.authMechanism = { from: before.authMechanism, to: next };
    }
  }
  if (input.requiredScopes !== undefined) {
    const next = cleanStringArray(input.requiredScopes);
    if (JSON.stringify(next) !== JSON.stringify(before.requiredScopes)) {
      data.requiredScopes = next;
      changes.requiredScopes = { from: before.requiredScopes, to: next };
    }
  }
  if (input.capabilities !== undefined) {
    const next = cleanStringArray(input.capabilities);
    if (JSON.stringify(next) !== JSON.stringify(before.capabilities)) {
      data.capabilities = next;
      changes.capabilities = { from: before.capabilities, to: next };
    }
  }
  if (input.role !== undefined) {
    const next = input.role?.trim() || null;
    if (next !== before.role) {
      data.role = next;
      changes.role = { from: before.role, to: next };
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

  const updated = await superDb.integrationTarget.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "INTEGRATION_TARGET_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "IntegrationTarget",
    subjectId: before.id,
    payload: { code: before.code, changes: changes as Prisma.InputJsonValue },
  });

  return updated;
}

export type SetIntegrationStatusInput = {
  code: string;
  status: IntegrationStatus;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function setIntegrationStatus(
  input: SetIntegrationStatusInput,
): Promise<IntegrationTarget> {
  const before = await superDb.integrationTarget.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`integration: ${input.code} not found`);
  if (before.status === input.status) return before;

  const data: Prisma.IntegrationTargetUpdateInput = { status: input.status };
  if (input.status === "AVAILABLE" && !before.availableSince) {
    data.availableSince = new Date();
  }
  if (input.status === "DEPRECATED") {
    data.deprecatedAt = new Date();
  }
  if (input.notes?.trim()) {
    data.notes = before.notes
      ? `${before.notes}\n\n[${input.status.toLowerCase()}] ${input.notes.trim()}`
      : `[${input.status.toLowerCase()}] ${input.notes.trim()}`;
  }

  const updated = await superDb.integrationTarget.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "INTEGRATION_TARGET_STATUS_CHANGED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "IntegrationTarget",
    subjectId: before.id,
    payload: {
      code: before.code,
      from: before.status,
      to: input.status,
      hadNotes: !!input.notes?.trim(),
    },
  });

  return updated;
}

export function isAcumonIntegrationOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}

function cleanStringArray(input: string[] | undefined): string[] {
  if (!input) return [];
  return input
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 50);
}

export const TIER_LABELS: Record<IntegrationTier, string> = {
  TIER_1: "Tier 1 — required at GA",
  TIER_2: "Tier 2 — within 6 months of GA",
  TIER_3: "Tier 3 — roadmap",
  SDK: "Generic Integration Capability (§10.4)",
};

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  PLANNED: "Planned",
  IN_DEVELOPMENT: "In development",
  AVAILABLE: "Available",
  DEPRECATED: "Deprecated",
};

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  EMAIL: "Email",
  CHAT: "Chat / messaging",
  DOCUMENTS: "Documents",
  CALENDAR: "Calendar",
  MEETINGS: "Meetings",
  E_SIGNATURE: "E-signature",
  PRACTICE_MANAGEMENT: "Practice management",
  CRM: "CRM",
  KNOWLEDGE_BASE: "Knowledge base",
  ACCOUNTING: "Accounting / billing",
  TASK_MANAGEMENT: "Task management",
  OTHER: "Other",
};
