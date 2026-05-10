import type { Prisma, AuditEventType } from "@prisma/client";
import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";

/**
 * Enqueue a webhook delivery for every enabled subscription whose
 * `eventTypes` array includes this event (or the wildcard `*`).
 *
 * Called from `writeAuditEvent` (see `src/lib/audit.ts`) AFTER the audit row
 * has been committed so that:
 *   - the receiver always sees a payload that has been hash-anchored,
 *   - a transient enqueue failure NEVER rolls back the audit chain.
 *
 * Failures are reported via `reportError` and swallowed — webhook
 * dispatch is a downstream side effect; it must not break the load-bearing
 * audit/transaction path. The cron worker drains PENDING rows on its own
 * cadence, so a single missed enqueue means a missed delivery for that
 * event but does not corrupt anything.
 */

export type EnqueueInput = {
  tenantId: string;
  eventType: AuditEventType;
  /** Audit row id, when known (always set when called from writeAuditEvent). */
  auditEventId?: string | null;
  /** Canonical payload for the receiver. */
  payload: WebhookPayload;
};

export type WebhookPayload = {
  /** Audit-event id; mirrors auditEventId. */
  id: string;
  /**
   * Tenant slug for downstream routing — receivers may host >1 tenant.
   * Set to the empty string by callers that don't have it; `enqueueWebhooks`
   * resolves the live slug lazily before it persists the delivery row.
   */
  tenantSlug: string;
  eventType: AuditEventType;
  /** ISO timestamp of the underlying audit row. */
  occurredAt: string;
  subjectType: string;
  subjectId: string;
  actorMembershipId: string | null;
  /** The audit event's `payload` field, shape-preserved. */
  data: Prisma.JsonValue;
};

export async function enqueueWebhooks(input: EnqueueInput): Promise<{ enqueued: number }> {
  try {
    const subs = await superDb.webhookSubscription.findMany({
      where: {
        tenantId: input.tenantId,
        enabled: true,
      },
      select: {
        id: true,
        eventTypes: true,
      },
    });
    if (subs.length === 0) return { enqueued: 0 };

    const matching = subs.filter((s) => matchesEvent(s.eventTypes, input.eventType));
    if (matching.length === 0) return { enqueued: 0 };

    // Resolve the tenant slug lazily — only when there's at least one
    // matching subscription so tenants without subscriptions pay nothing.
    let payload = input.payload;
    if (!payload.tenantSlug) {
      const tenant = await superDb.tenant.findUnique({
        where: { id: input.tenantId },
        select: { slug: true },
      });
      payload = { ...payload, tenantSlug: tenant?.slug ?? "" };
    }

    const now = new Date();
    await superDb.webhookDelivery.createMany({
      data: matching.map((s) => ({
        tenantId: input.tenantId,
        subscriptionId: s.id,
        eventType: input.eventType,
        auditEventId: input.auditEventId ?? null,
        payload: payload as unknown as Prisma.InputJsonValue,
        attempt: 0,
        status: "PENDING",
        scheduledFor: now,
      })),
    });
    return { enqueued: matching.length };
  } catch (err) {
    // Webhook dispatch must not fail an audit write. Log loudly and move on.
    reportError(err, {
      route: "webhooks/enqueue",
      tenantId: input.tenantId,
      tags: { eventType: input.eventType },
    });
    return { enqueued: 0 };
  }
}

function matchesEvent(subscribedTo: string[], event: string): boolean {
  if (subscribedTo.includes("*")) return true;
  return subscribedTo.includes(event);
}

/**
 * Manual replay path. Re-enqueues the same payload as a fresh PENDING
 * delivery against the same subscription. Audited as WEBHOOK_REPLAYED so
 * the chain shows the operator who triggered it.
 */
export async function replayDelivery(input: {
  tenantId: string;
  deliveryId: string;
}): Promise<{ replayed: boolean; newDeliveryId?: string }> {
  const original = await superDb.webhookDelivery.findFirst({
    where: { id: input.deliveryId, tenantId: input.tenantId },
  });
  if (!original) return { replayed: false };
  const sub = await superDb.webhookSubscription.findFirst({
    where: { id: original.subscriptionId, tenantId: input.tenantId },
    select: { id: true, enabled: true },
  });
  if (!sub) return { replayed: false };
  const created = await superDb.webhookDelivery.create({
    data: {
      tenantId: input.tenantId,
      subscriptionId: original.subscriptionId,
      eventType: original.eventType,
      auditEventId: original.auditEventId,
      payload: original.payload as Prisma.InputJsonValue,
      attempt: 0,
      status: "PENDING",
      scheduledFor: new Date(),
    },
  });
  return { replayed: true, newDeliveryId: created.id };
}
