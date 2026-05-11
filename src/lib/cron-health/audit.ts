import type { AuditEventType, Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";

/**
 * Cron events are platform-wide. Per the established pattern (Roadmap §16,
 * Risks §17), platform-wide operator events land on the Acumon operator
 * tenant's audit chain. If no acumon tenant exists in this environment
 * (early dev / test), we log via `reportError` instead.
 */
export async function writeCronAuditOnAcumon(
  eventType: AuditEventType,
  cronName: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  try {
    const operator = await superDb.tenant.findUnique({
      where: { slug: "acumon" },
      select: { id: true },
    });
    if (!operator) {
      reportError(
        new Error(`No acumon operator tenant; skipping ${eventType} for cron ${cronName}`),
        { tags: { kind: "cron-health-audit", cronName, eventType } },
      );
      return;
    }
    await writeAuditEvent({
      tenantId: operator.id,
      eventType,
      subjectType: "cron",
      subjectId: cronName,
      payload,
    });
  } catch (err) {
    reportError(err, { tags: { kind: "cron-health-audit", cronName, eventType } });
  }
}

export async function acumonTenantId(): Promise<string | null> {
  try {
    const operator = await superDb.tenant.findUnique({
      where: { slug: "acumon" },
      select: { id: true },
    });
    return operator?.id ?? null;
  } catch {
    return null;
  }
}
