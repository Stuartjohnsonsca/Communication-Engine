import type {
  BreachClientNotification,
  BreachIncident,
  BreachSeverity,
  BreachStatus,
  Prisma,
} from "@prisma/client";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §12.9 Breach Notification.
 *
 * Acumon Intelligence (as processor) notifies affected Clients without
 * undue delay and within 24 hours of becoming aware of a personal-data
 * breach. The notification carries everything the Client needs to meet
 * its 72-hour ICO/EDPB obligation.
 *
 * Two surfaces:
 *   - **Acumon operator console** (breach:manage, gated on
 *     `tenant.slug === "acumon"`): record incidents, triage, contain,
 *     resolve, dispatch per-Client notifications.
 *   - **Per-Client breach inbox** (breach:read in their own tenant): see
 *     notifications addressed to them, acknowledge receipt.
 *
 * `BreachIncident` is global (Acumon-side); `BreachClientNotification` is
 * tenant-scoped + RLS-protected so each Client only sees their own.
 */

const ACUMON_TENANT_SLUG = "acumon";
const NOTIFY_DEADLINE_HOURS = 24;

export function isAcumonBreachOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}

// ─── Operator side (global) ───────────────────────────────────────────────

export type CreateIncidentInput = {
  title: string;
  description: string;
  severity: BreachSeverity;
  detectedAt?: Date;
  awareAt: Date;
  isPersonalData?: boolean;
  affectedCategories?: string[];
  recordedByName: string;
  /** Acumon operator's tenant — for audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function createBreachIncident(input: CreateIncidentInput): Promise<BreachIncident> {
  if (!input.title.trim()) throw new Error("breach: title required");
  if (!input.description.trim()) throw new Error("breach: description required");
  if (!input.recordedByName.trim()) throw new Error("breach: recordedByName required");

  const code = await nextIncidentCode();
  const created = await superDb.breachIncident.create({
    data: {
      code,
      title: input.title.trim(),
      description: input.description.trim(),
      severity: input.severity,
      detectedAt: input.detectedAt ?? null,
      awareAt: input.awareAt,
      isPersonalData: input.isPersonalData ?? true,
      affectedCategories: cleanCategories(input.affectedCategories),
      recordedByName: input.recordedByName.trim(),
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "BREACH_DETECTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "BreachIncident",
    subjectId: created.id,
    payload: {
      code,
      severity: created.severity,
      awareAt: created.awareAt.toISOString(),
      isPersonalData: created.isPersonalData,
    },
  });

  return created;
}

async function nextIncidentCode(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `BR-${year}-`;
  const last = await superDb.breachIncident.findFirst({
    where: { code: { startsWith: prefix } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  let n = 1;
  if (last) {
    const tail = last.code.slice(prefix.length);
    const parsed = Number.parseInt(tail, 10);
    if (Number.isFinite(parsed)) n = parsed + 1;
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

export type UpdateIncidentInput = {
  incidentId: string;
  status?: BreachStatus;
  severity?: BreachSeverity;
  rootCause?: string | null;
  mitigations?: string[];
  affectedCategories?: string[];
  isPersonalData?: boolean;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updateBreachIncident(input: UpdateIncidentInput): Promise<BreachIncident> {
  const before = await superDb.breachIncident.findUnique({ where: { id: input.incidentId } });
  if (!before) throw new Error("breach: incident not found");

  const data: Prisma.BreachIncidentUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.status !== undefined && input.status !== before.status) {
    data.status = input.status;
    changes.status = { from: before.status, to: input.status };
    if (input.status === "CONTAINED" && !before.containedAt) {
      data.containedAt = new Date();
    }
    if (input.status === "RESOLVED" && !before.resolvedAt) {
      data.resolvedAt = new Date();
    }
  }
  if (input.severity !== undefined && input.severity !== before.severity) {
    data.severity = input.severity;
    changes.severity = { from: before.severity, to: input.severity };
  }
  if (input.rootCause !== undefined) {
    const next = input.rootCause?.trim() || null;
    if (next !== before.rootCause) {
      data.rootCause = next;
      changes.rootCause = { from: before.rootCause, to: next };
    }
  }
  if (input.mitigations !== undefined) {
    const next = cleanCategories(input.mitigations);
    if (JSON.stringify(next) !== JSON.stringify(before.mitigations)) {
      data.mitigations = next;
      changes.mitigations = { from: before.mitigations, to: next };
    }
  }
  if (input.affectedCategories !== undefined) {
    const next = cleanCategories(input.affectedCategories);
    if (JSON.stringify(next) !== JSON.stringify(before.affectedCategories)) {
      data.affectedCategories = next;
      changes.affectedCategories = { from: before.affectedCategories, to: next };
    }
  }
  if (input.isPersonalData !== undefined && input.isPersonalData !== before.isPersonalData) {
    data.isPersonalData = input.isPersonalData;
    changes.isPersonalData = { from: before.isPersonalData, to: input.isPersonalData };
  }

  if (Object.keys(changes).length === 0) return before;

  const updated = await superDb.breachIncident.update({
    where: { id: before.id },
    data,
  });

  let eventType: Prisma.BreachIncidentUpdateInput extends never
    ? never
    : "BREACH_TRIAGED" | "BREACH_CONTAINED" | "BREACH_RESOLVED" | "BREACH_UPDATE_PUBLISHED";
  if (input.status === "CONTAINED") eventType = "BREACH_CONTAINED";
  else if (input.status === "RESOLVED") eventType = "BREACH_RESOLVED";
  else if (input.status && input.status !== before.status) eventType = "BREACH_TRIAGED";
  else eventType = "BREACH_UPDATE_PUBLISHED";

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType,
    actorMembershipId: input.actorMembershipId,
    subjectType: "BreachIncident",
    subjectId: before.id,
    payload: { code: before.code, changes: changes as Prisma.InputJsonValue },
  });

  return updated;
}

// ─── Notifications (per affected Client) ──────────────────────────────────

export type AddAffectedTenantInput = {
  incidentId: string;
  tenantId: string;
  /** Custom dispatch deadline override; defaults to incident.awareAt + 24h. */
  dueAt?: Date;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function addAffectedTenant(
  input: AddAffectedTenantInput,
): Promise<BreachClientNotification> {
  const incident = await superDb.breachIncident.findUnique({ where: { id: input.incidentId } });
  if (!incident) throw new Error("breach: incident not found");

  const dueAt = input.dueAt ?? new Date(incident.awareAt.getTime() + NOTIFY_DEADLINE_HOURS * 3_600_000);

  const created = await tenantDb(input.tenantId).breachClientNotification.create({
    data: {
      tenantId: input.tenantId,
      breachIncidentId: input.incidentId,
      status: "PENDING",
      dueAt,
      notes: input.notes?.trim() || null,
    },
  });

  // Bump the affected count on the incident.
  await superDb.breachIncident.update({
    where: { id: incident.id },
    data: {
      affectedClientCount: await superDb.breachClientNotification.count({
        where: { breachIncidentId: incident.id },
      }),
    },
  });

  return created;
}

export type DispatchNotificationInput = {
  notificationId: string;
  tenantId: string;
  notifiedByName: string;
  notifiedToName: string;
  notifiedToRole: string;
  /** Body of the notification — markdown. */
  payload: string;
  /** Operator's tenant (Acumon). */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function dispatchNotification(
  input: DispatchNotificationInput,
): Promise<BreachClientNotification> {
  if (!input.payload.trim()) throw new Error("breach: notification payload required");
  if (!input.notifiedByName.trim()) throw new Error("breach: notifiedByName required");
  if (!input.notifiedToName.trim()) throw new Error("breach: notifiedToName required");

  const before = await tenantDb(input.tenantId).breachClientNotification.findFirst({
    where: { id: input.notificationId, tenantId: input.tenantId },
  });
  if (!before) throw new Error("breach: notification not found");
  if (before.status !== "PENDING" && before.status !== "SUPERSEDED") {
    throw new Error(`breach: cannot dispatch from status ${before.status}`);
  }

  const updated = await tenantDb(input.tenantId).breachClientNotification.update({
    where: { id: before.id },
    data: {
      status: "NOTIFIED",
      notifiedAt: new Date(),
      notifiedByName: input.notifiedByName.trim(),
      notifiedToName: input.notifiedToName.trim(),
      notifiedToRole: input.notifiedToRole.trim(),
      payload: input.payload.trim(),
    },
  });

  // Audit on the AFFECTED tenant's chain — that is the customer-facing
  // record of receipt + the contractually meaningful event for the DPA.
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "BREACH_CLIENT_NOTIFIED",
    actorMembershipId: null,
    subjectType: "BreachClientNotification",
    subjectId: before.id,
    payload: {
      incidentId: before.breachIncidentId,
      notifiedByName: input.notifiedByName,
      notifiedToName: input.notifiedToName,
      notifiedToRole: input.notifiedToRole,
      withinSla: new Date() <= before.dueAt,
    },
  });

  // Mirror on the operator's chain so Acumon's audit also shows dispatch.
  if (input.actorTenantId !== input.tenantId) {
    await writeAuditEvent({
      tenantId: input.actorTenantId,
      eventType: "BREACH_UPDATE_PUBLISHED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "BreachClientNotification",
      subjectId: before.id,
      payload: {
        incidentId: before.breachIncidentId,
        affectedTenantId: input.tenantId,
      },
    });
  }

  return updated;
}

export type AckNotificationInput = {
  notificationId: string;
  tenantId: string;
  acknowledgedByName: string;
  notes?: string | null;
  actorMembershipId: string;
};

export async function acknowledgeNotification(
  input: AckNotificationInput,
): Promise<BreachClientNotification> {
  if (!input.acknowledgedByName.trim()) {
    throw new Error("breach: acknowledgedByName required");
  }
  const before = await tenantDb(input.tenantId).breachClientNotification.findFirst({
    where: { id: input.notificationId, tenantId: input.tenantId },
  });
  if (!before) throw new Error("breach: notification not found");
  if (before.status !== "NOTIFIED") {
    throw new Error(`breach: cannot acknowledge from status ${before.status}`);
  }

  const updated = await tenantDb(input.tenantId).breachClientNotification.update({
    where: { id: before.id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedAt: new Date(),
      acknowledgedByName: input.acknowledgedByName.trim(),
      notes: input.notes?.trim() || before.notes,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "BREACH_UPDATE_PUBLISHED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "BreachClientNotification",
    subjectId: before.id,
    payload: {
      acknowledgedByName: input.acknowledgedByName,
      incidentId: before.breachIncidentId,
    },
  });

  return updated;
}

// ─── Read views ───────────────────────────────────────────────────────────

export async function listOperatorIncidents(): Promise<
  Array<BreachIncident & { dueAt: Date; openNotifications: number; overdue: number }>
> {
  const incidents = await superDb.breachIncident.findMany({
    orderBy: { awareAt: "desc" },
    take: 50,
  });
  const ids = incidents.map((i) => i.id);
  const notifications = ids.length
    ? await superDb.breachClientNotification.findMany({
        where: { breachIncidentId: { in: ids } },
      })
    : [];
  const now = Date.now();
  return incidents.map((i) => {
    const own = notifications.filter((n) => n.breachIncidentId === i.id);
    return {
      ...i,
      dueAt: new Date(i.awareAt.getTime() + NOTIFY_DEADLINE_HOURS * 3_600_000),
      openNotifications: own.filter((n) => n.status === "PENDING").length,
      overdue: own.filter(
        (n) => n.status === "PENDING" && n.dueAt.getTime() < now,
      ).length,
    };
  });
}

export async function getOperatorIncident(
  incidentId: string,
): Promise<{
  incident: BreachIncident;
  notifications: Array<BreachClientNotification & { tenantSlug: string; tenantName: string }>;
} | null> {
  const incident = await superDb.breachIncident.findUnique({ where: { id: incidentId } });
  if (!incident) return null;
  const rawNotifications = await superDb.breachClientNotification.findMany({
    where: { breachIncidentId: incidentId },
    include: { tenant: { select: { slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const notifications = rawNotifications.map(({ tenant, ...rest }) => ({
    ...rest,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
  }));
  return { incident, notifications };
}

export async function listAvailableTenantsForIncident(
  incidentId: string,
): Promise<Array<{ id: string; slug: string; name: string }>> {
  const existing = await superDb.breachClientNotification.findMany({
    where: { breachIncidentId: incidentId },
    select: { tenantId: true },
  });
  const taken = new Set(existing.map((n) => n.tenantId));
  const all = await superDb.tenant.findMany({
    where: {
      isSandbox: false,
      status: { notIn: ["TERMINATED"] },
    },
    select: { id: true, slug: true, name: true },
    orderBy: { name: "asc" },
  });
  return all.filter((t) => !taken.has(t.id));
}

export async function listClientNotifications(
  tenantId: string,
): Promise<Array<BreachClientNotification & { incident: BreachIncident }>> {
  const rows = await tenantDb(tenantId).breachClientNotification.findMany({
    where: { tenantId },
    include: { incident: true },
    orderBy: { dueAt: "desc" },
    take: 50,
  });
  return rows;
}

function cleanCategories(input: string[] | undefined): string[] {
  if (!input) return [];
  return input
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 30);
}

export const SEVERITY_LABELS: Record<BreachSeverity, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

export const STATUS_LABELS: Record<BreachStatus, string> = {
  TRIAGE: "Triage",
  INVESTIGATING: "Investigating",
  CONTAINED: "Contained",
  RESOLVED: "Resolved",
};

export const NOTIFICATION_DEADLINE_HOURS = NOTIFY_DEADLINE_HOURS;
