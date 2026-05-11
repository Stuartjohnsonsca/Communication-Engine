/**
 * Webhook subscription "Send test event" (post-PRD hardening).
 *
 * Integrator onboarding pain point: a Firm Administrator creates a
 * webhook subscription, copies the signing secret into their receiver,
 * then has to WAIT for a real audit event to fire to validate the
 * end-to-end pipeline. For low-volume tenants that can take days.
 *
 * `fireTestEvent` synthesises a single targeted `WebhookDelivery` row
 * for the chosen subscription with a sentinel payload and lets the
 * existing delivery worker run it through the full pipeline (HMAC
 * signing, exponential backoff retries, body cap, SSRF check, audit
 * trail on terminal outcomes). The receiver sees a real
 * `X-Acumon-Event: WEBHOOK_SUBSCRIPTION_TESTED` POST signed with their
 * actual secret — same exact shape as a production delivery, so they
 * can confidently validate their signature-verification path.
 *
 * Why not just write a synthetic AuditEvent and let the fan-out enqueue
 * it: that would deliver to EVERY subscription matching wildcard or
 * the event type, not just the one being tested. Item 14's
 * `WEBHOOK_SELF_EVENT_TYPES` exclusion catches it on our side too —
 * the test-fire path bypasses `enqueueWebhooks` entirely and writes
 * directly to `WebhookDelivery`. The audit row is for forensic record
 * only, not as a fan-out trigger.
 *
 * Allows testing DISABLED subscriptions: the procurement use case is
 * "verify signature handling before flipping enabled=true" — refusing
 * disabled subs would defeat the point. The delivery worker's own
 * disabled-subscription guard would still skip it (see
 * `attemptDelivery`), so we surface the unenabled state as a `note`
 * in the result rather than silently no-op'ing.
 */
import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

export const TEST_EVENT_TYPE = "WEBHOOK_SUBSCRIPTION_TESTED" as const;

export type FireTestEventInput = {
  tenantId: string;
  subscriptionId: string;
  actorMembershipId: string;
  /** Optional integrator-supplied note carried in the sentinel payload. */
  note?: string | null;
  /** Optional clock injection for tests. */
  now?: Date;
};

export type FireTestEventResult =
  | { ok: true; deliveryId: string; subscriptionEnabled: boolean }
  | { ok: false; reason: "subscription-not-found" };

export class WebhookTestFireError extends Error {
  code: "subscription-not-found";
  constructor(code: "subscription-not-found", message: string) {
    super(message);
    this.name = "WebhookTestFireError";
    this.code = code;
  }
}

export async function fireTestEvent(input: FireTestEventInput): Promise<FireTestEventResult> {
  const sub = await superDb.webhookSubscription.findFirst({
    where: { id: input.subscriptionId, tenantId: input.tenantId },
    select: { id: true, enabled: true },
  });
  if (!sub) {
    return { ok: false, reason: "subscription-not-found" };
  }

  const now = input.now ?? new Date();

  // Build the sentinel payload using the canonical WebhookPayload shape
  // from `dispatch.ts` so the receiver sees the same field structure as
  // a real event. tenantSlug is resolved here (the dispatch path does
  // it lazily; the test path knows the tenant explicitly).
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { slug: true },
  });

  // The auditEvent id will be filled after we write the audit row, but
  // we want the WebhookDelivery to reference it (so a receiver inspecting
  // its receipt log against /api/v1/audit can correlate). Write the audit
  // first; then create the delivery referencing its id.
  const auditEvent = await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: TEST_EVENT_TYPE,
    actorMembershipId: input.actorMembershipId,
    subjectType: "WebhookSubscription",
    subjectId: sub.id,
    payload: {
      subscriptionId: sub.id,
      subscriptionEnabled: sub.enabled,
      note: input.note ?? null,
    },
  });

  const payload = {
    id: auditEvent.id,
    tenantSlug: tenant?.slug ?? "",
    eventType: TEST_EVENT_TYPE,
    occurredAt: auditEvent.createdAt.toISOString(),
    subjectType: "WebhookSubscription",
    subjectId: sub.id,
    actorMembershipId: input.actorMembershipId,
    data: {
      test: true,
      note: input.note ?? null,
      message:
        "This is a test event sent from the Acumon admin console. Receivers may safely ignore.",
    } as Prisma.JsonValue,
  };

  const delivery = await superDb.webhookDelivery.create({
    data: {
      tenantId: input.tenantId,
      subscriptionId: sub.id,
      eventType: TEST_EVENT_TYPE,
      auditEventId: auditEvent.id,
      payload: payload as unknown as Prisma.InputJsonValue,
      attempt: 0,
      status: "PENDING",
      scheduledFor: now,
    },
  });

  return {
    ok: true,
    deliveryId: delivery.id,
    subscriptionEnabled: sub.enabled,
  };
}
