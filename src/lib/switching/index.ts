import type { Prisma, SubProcessor } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Switching and lock-in posture (PRD §15.3).
 *
 * Three commitments under §15.3:
 *   1. Acumon publishes its sub-processor list, integration APIs and export
 *      schemas in advance of contracting. The sub-processor list is the
 *      management surface in this module; integration APIs + export schema
 *      are documented on the page from PRD §10 + the §14.4 export schema.
 *   2. No switching charges after January 2027 (EU Data Act). Static notice
 *      on the page; no billing surface change required.
 *   3. Customer data is exportable on demand at no charge during the
 *      contract — already implemented as part of §14.4
 *      (`/api/termination/export`); the page links to it.
 *
 * Sub-processors are global (no tenantId, NOT under RLS), like Roadmap and
 * Risks. Mutations are gated by the page handler to Acumon-tenant operators
 * (FIRM_ADMIN of "acumon" or ACUMON_ADMIN). Audit events are written
 * against the operator's tenant chain.
 */

const ACUMON_TENANT_SLUG = "acumon";

export type SubProcessorView = {
  active: SubProcessor[];
  inactive: SubProcessor[];
};

export async function getSubProcessors(): Promise<SubProcessorView> {
  const all = await superDb.subProcessor.findMany({ orderBy: { ordinal: "asc" } });
  return {
    active: all.filter((s) => s.isActive),
    inactive: all.filter((s) => !s.isActive),
  };
}

// ─── Mutations ────────────────────────────────────────────────────────────

export type AddSubProcessorInput = {
  code: string;
  name: string;
  role: string;
  jurisdiction: string;
  dataCategories: string[];
  contractRef?: string | null;
  notes?: string | null;
  /** Operator's tenant — for audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function addSubProcessor(input: AddSubProcessorInput): Promise<SubProcessor> {
  const code = input.code.trim().toLowerCase();
  if (!code) throw new Error("subprocessor: code is required");
  if (!/^[a-z0-9_-]+$/.test(code)) {
    throw new Error("subprocessor: code must be lowercase alphanumeric with - or _");
  }
  if (!input.name.trim()) throw new Error("subprocessor: name is required");

  const existing = await superDb.subProcessor.findUnique({ where: { code } });
  if (existing) throw new Error(`subprocessor: code ${code} already exists`);

  // Place new entries at the end of the ordinal sequence.
  const max = await superDb.subProcessor.aggregate({ _max: { ordinal: true } });
  const ordinal = (max._max.ordinal ?? -1) + 1;

  const created = await superDb.subProcessor.create({
    data: {
      code,
      ordinal,
      name: input.name.trim(),
      role: input.role.trim(),
      jurisdiction: input.jurisdiction.trim(),
      dataCategories: input.dataCategories
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .slice(0, 30),
      contractRef: input.contractRef?.trim() || null,
      notes: input.notes?.trim() || null,
      isActive: true,
      addedAt: new Date(),
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SUBPROCESSOR_ADDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SubProcessor",
    subjectId: created.id,
    payload: {
      code,
      name: created.name,
      jurisdiction: created.jurisdiction,
      dataCategories: created.dataCategories as Prisma.InputJsonValue,
    },
  });

  return created;
}

export type UpdateSubProcessorInput = {
  code: string;
  name?: string;
  role?: string;
  jurisdiction?: string;
  dataCategories?: string[];
  contractRef?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updateSubProcessor(
  input: UpdateSubProcessorInput,
): Promise<SubProcessor> {
  const before = await superDb.subProcessor.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`subprocessor: ${input.code} not found`);

  const data: Prisma.SubProcessorUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.name !== undefined && input.name.trim() !== before.name) {
    data.name = input.name.trim();
    changes.name = { from: before.name, to: data.name };
  }
  if (input.role !== undefined && input.role.trim() !== before.role) {
    data.role = input.role.trim();
    changes.role = { from: before.role, to: data.role };
  }
  if (input.jurisdiction !== undefined && input.jurisdiction.trim() !== before.jurisdiction) {
    data.jurisdiction = input.jurisdiction.trim();
    changes.jurisdiction = { from: before.jurisdiction, to: data.jurisdiction };
  }
  if (input.dataCategories !== undefined) {
    const next = input.dataCategories
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, 30);
    if (JSON.stringify(next) !== JSON.stringify(before.dataCategories)) {
      data.dataCategories = next;
      changes.dataCategories = { from: before.dataCategories, to: next };
    }
  }
  if (input.contractRef !== undefined) {
    const next = input.contractRef?.trim() || null;
    if (next !== before.contractRef) {
      data.contractRef = next;
      changes.contractRef = { from: before.contractRef, to: next };
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

  const updated = await superDb.subProcessor.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SUBPROCESSOR_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SubProcessor",
    subjectId: before.id,
    payload: { code: before.code, changes: changes as Prisma.InputJsonValue },
  });

  return updated;
}

export type SetActiveInput = {
  code: string;
  active: boolean;
  /** Reason / notes the operator records on a removal or reinstatement. */
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function setSubProcessorActive(input: SetActiveInput): Promise<SubProcessor> {
  const before = await superDb.subProcessor.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`subprocessor: ${input.code} not found`);
  if (before.isActive === input.active) return before;

  const updated = await superDb.subProcessor.update({
    where: { id: before.id },
    data: input.active
      ? {
          isActive: true,
          removedAt: null,
          // Append the reinstatement note to existing notes so the trail
          // remains visible without overwriting earlier removal context.
          notes:
            input.notes?.trim()
              ? before.notes
                ? `${before.notes}\n\n[reinstated] ${input.notes.trim()}`
                : `[reinstated] ${input.notes.trim()}`
              : before.notes,
        }
      : {
          isActive: false,
          removedAt: new Date(),
          notes:
            input.notes?.trim()
              ? before.notes
                ? `${before.notes}\n\n[removed] ${input.notes.trim()}`
                : `[removed] ${input.notes.trim()}`
              : before.notes,
        },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: input.active ? "SUBPROCESSOR_REINSTATED" : "SUBPROCESSOR_REMOVED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SubProcessor",
    subjectId: before.id,
    payload: {
      code: before.code,
      hadNotes: !!input.notes?.trim(),
    },
  });

  return updated;
}

export function isAcumonOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}
