import type { Prisma, RoadmapExitCriterion, RoadmapPhase, RoadmapPhaseStatus } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Roadmap module (PRD §16). Global product-roadmap state — same five phases
 * (P0–P4) for every tenant. Mutations are restricted to Acumon operators
 * (FIRM_ADMIN of the "acumon" tenant or ACUMON_ADMIN); the audit event is
 * written against the operator's tenant chain.
 *
 * Roadmap rows live outside RLS — see `prisma/rls.sql`. Tenant scoping does
 * not apply because the data is not personal and not per-Client.
 */

export type RoadmapPhaseWithCriteria = RoadmapPhase & {
  exitCriteria: RoadmapExitCriterion[];
};

export type RoadmapView = {
  phases: RoadmapPhaseWithCriteria[];
  /** The phase the operator currently considers in flight. Null if none. */
  activePhase: RoadmapPhaseWithCriteria | null;
};

export async function getRoadmap(): Promise<RoadmapView> {
  const phases = await superDb.roadmapPhase.findMany({
    orderBy: { ordinal: "asc" },
    include: { exitCriteria: { orderBy: { ordinal: "asc" } } },
  });
  const activePhase = phases.find((p) => p.status === "ACTIVE") ?? null;
  return { phases, activePhase };
}

export type PhaseSummary = {
  code: string;
  name: string;
  status: RoadmapPhaseStatus;
  windowMonthsStart: number;
  windowMonthsEnd: number;
  exitCriteriaTotal: number;
  exitCriteriaMet: number;
};

export function summarisePhase(p: RoadmapPhaseWithCriteria): PhaseSummary {
  return {
    code: p.code,
    name: p.name,
    status: p.status,
    windowMonthsStart: p.windowMonthsStart,
    windowMonthsEnd: p.windowMonthsEnd,
    exitCriteriaTotal: p.exitCriteria.length,
    exitCriteriaMet: p.exitCriteria.filter((c) => c.metAt != null).length,
  };
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export type UpdatePhaseInput = {
  code: string;
  status?: RoadmapPhaseStatus;
  notes?: string | null;
  /** Operator's tenant — for audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updatePhase(input: UpdatePhaseInput): Promise<RoadmapPhase> {
  const before = await superDb.roadmapPhase.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`roadmap: phase ${input.code} not found`);

  const data: Prisma.RoadmapPhaseUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.status !== undefined && input.status !== before.status) {
    data.status = input.status;
    changes.status = { from: before.status, to: input.status };
    // Stamp lifecycle markers on transitions. Idempotent: subsequent
    // moves into the same state don't overwrite an existing timestamp.
    if (input.status === "ACTIVE" && !before.startedAt) {
      data.startedAt = new Date();
    }
    if (input.status === "COMPLETE" && !before.completedAt) {
      data.completedAt = new Date();
    }
  }

  if (input.notes !== undefined) {
    const trimmed = input.notes?.trim() || null;
    if (trimmed !== before.notes) {
      data.notes = trimmed;
      changes.notes = { from: before.notes, to: trimmed };
    }
  }

  if (Object.keys(changes).length === 0) return before;

  const after = await superDb.roadmapPhase.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "ROADMAP_PHASE_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "RoadmapPhase",
    subjectId: before.id,
    payload: {
      code: before.code,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  return after;
}

export type SetExitCriterionInput = {
  criterionId: string;
  met: boolean;
  /** Captured for the public roadmap card. Optional — falls back to actor name. */
  metByName?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
  /** Used as the default `metByName` if the caller didn't supply one. */
  actorName: string;
};

export async function setExitCriterion(input: SetExitCriterionInput): Promise<RoadmapExitCriterion> {
  const before = await superDb.roadmapExitCriterion.findUnique({
    where: { id: input.criterionId },
    include: { phase: { select: { code: true, id: true } } },
  });
  if (!before) throw new Error(`roadmap: exit criterion ${input.criterionId} not found`);

  const wasMet = before.metAt != null;
  if (wasMet === input.met && input.notes === undefined) return before;

  const data: Prisma.RoadmapExitCriterionUpdateInput = {};
  if (input.met && !wasMet) {
    data.metAt = new Date();
    data.metByName = (input.metByName?.trim() || input.actorName.trim() || null);
  } else if (!input.met && wasMet) {
    data.metAt = null;
    data.metByName = null;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes?.trim() || null;
  }

  const after = await superDb.roadmapExitCriterion.update({
    where: { id: input.criterionId },
    data,
  });

  if (wasMet !== input.met) {
    await writeAuditEvent({
      tenantId: input.actorTenantId,
      eventType: input.met ? "ROADMAP_EXIT_CRITERION_MET" : "ROADMAP_EXIT_CRITERION_UNMET",
      actorMembershipId: input.actorMembershipId,
      subjectType: "RoadmapExitCriterion",
      subjectId: after.id,
      payload: {
        phaseCode: before.phase.code,
        text: before.text,
        metByName: after.metByName,
      },
    });
  }

  return after;
}
