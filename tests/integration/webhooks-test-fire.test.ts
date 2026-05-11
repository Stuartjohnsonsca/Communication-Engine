/**
 * Webhook subscription "Send test event" (post-PRD hardening).
 *
 * Coverage:
 *   - Happy path: creates a PENDING WebhookDelivery for the target
 *     subscription only, with eventType=WEBHOOK_SUBSCRIPTION_TESTED,
 *     auditEventId set, payload shape matching the canonical
 *     WebhookPayload contract, scheduledFor = injected `now`.
 *   - Writes a WEBHOOK_SUBSCRIPTION_TESTED audit row with the actor +
 *     subjectType=WebhookSubscription + subjectId=subscription id +
 *     payload carrying the note + subscriptionEnabled flag.
 *   - Disabled subscription is permitted (procurement use case: test
 *     before enabling). `subscriptionEnabled: false` flows into both
 *     the result and the audit payload.
 *   - Missing subscription returns `{ok:false, reason:"subscription-
 *     not-found"}` and writes NEITHER an audit row NOR a delivery row.
 *   - Cross-tenant safety: a subscription belonging to tenant B cannot
 *     be fired from tenant A even if the id is guessed.
 *   - **No fan-out invariant**: writing the WEBHOOK_SUBSCRIPTION_TESTED
 *     audit must NOT cause `enqueueWebhooks` to create extra
 *     WebhookDelivery rows in OTHER matching subscriptions. The
 *     `WEBHOOK_SELF_EVENT_TYPES` exclusion is what enforces this; the
 *     test seeds a wildcard-subscribed sibling subscription and
 *     asserts only ONE delivery row exists post-fire.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { superDb } from "@/lib/db";
import { createSubscription, fireTestEvent, TEST_EVENT_TYPE } from "@/lib/webhooks";

type Tenant = Awaited<ReturnType<typeof superDb.tenant.create>>;

async function makeTenant(slugPrefix = "tf"): Promise<Tenant> {
  return superDb.tenant.create({
    data: { slug: `${slugPrefix}-${randomUUID().slice(0, 8)}`, name: "test-fire test" },
  });
}

async function makeFirmAdmin(tenant: Tenant) {
  const user = await superDb.user.create({
    data: { email: `${randomUUID().slice(0, 8)}@example.test` },
  });
  return superDb.membership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
  });
}

async function cleanupTenant(tenantId: string) {
  await superDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
}

describe("fireTestEvent — happy path", () => {
  let tenant: Tenant;
  let admin: Awaited<ReturnType<typeof makeFirmAdmin>>;

  beforeEach(async () => {
    tenant = await makeTenant();
    admin = await makeFirmAdmin(tenant);
  });
  afterEach(async () => {
    await cleanupTenant(tenant.id);
  });

  it("creates a single PENDING WebhookDelivery for the target subscription with the right shape", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "happy receiver",
      url: "https://hooks.example.com/x",
      eventTypes: ["*"],
    });

    const fixedNow = new Date("2026-05-12T10:00:00.000Z");
    const result = await fireTestEvent({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: admin.id,
      note: "smoke test",
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptionEnabled).toBe(true);

    const delivery = await superDb.webhookDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
    });
    expect(delivery.subscriptionId).toBe(created.subscription.id);
    expect(delivery.tenantId).toBe(tenant.id);
    expect(delivery.eventType).toBe(TEST_EVENT_TYPE);
    expect(delivery.status).toBe("PENDING");
    expect(delivery.attempt).toBe(0);
    expect(delivery.scheduledFor.getTime()).toBe(fixedNow.getTime());
    expect(delivery.auditEventId).toBeTruthy();
    const payload = delivery.payload as Record<string, unknown>;
    expect(payload.eventType).toBe(TEST_EVENT_TYPE);
    expect(payload.subjectType).toBe("WebhookSubscription");
    expect(payload.subjectId).toBe(created.subscription.id);
    expect(payload.tenantSlug).toBe(tenant.slug);
    expect(payload.actorMembershipId).toBe(admin.id);
    const data = payload.data as Record<string, unknown>;
    expect(data.test).toBe(true);
    expect(data.note).toBe("smoke test");
  });

  it("writes a WEBHOOK_SUBSCRIPTION_TESTED audit row with the actor and note", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "audit receiver",
      url: "https://hooks.example.com/y",
      eventTypes: ["*"],
    });

    const result = await fireTestEvent({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: admin.id,
      note: "for the audit",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audit = await superDb.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_TESTED" },
      orderBy: { seq: "desc" },
    });
    expect(audit.actorMembershipId).toBe(admin.id);
    expect(audit.subjectType).toBe("WebhookSubscription");
    expect(audit.subjectId).toBe(created.subscription.id);
    const p = audit.payload as Record<string, unknown>;
    expect(p.subscriptionId).toBe(created.subscription.id);
    expect(p.subscriptionEnabled).toBe(true);
    expect(p.note).toBe("for the audit");
  });

  it("permits firing against a DISABLED subscription (procurement: test before enabling)", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "disabled receiver",
      url: "https://hooks.example.com/z",
      eventTypes: ["*"],
    });
    await superDb.webhookSubscription.update({
      where: { id: created.subscription.id },
      data: { enabled: false },
    });

    const result = await fireTestEvent({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: admin.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptionEnabled).toBe(false);

    const audit = await superDb.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_TESTED" },
    });
    const p = audit.payload as Record<string, unknown>;
    expect(p.subscriptionEnabled).toBe(false);
  });
});

describe("fireTestEvent — refuses gracefully", () => {
  let tenant: Tenant;
  let admin: Awaited<ReturnType<typeof makeFirmAdmin>>;

  beforeEach(async () => {
    tenant = await makeTenant();
    admin = await makeFirmAdmin(tenant);
  });
  afterEach(async () => {
    await cleanupTenant(tenant.id);
  });

  it("returns subscription-not-found and writes nothing when the id is unknown", async () => {
    const auditCountBefore = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_TESTED" },
    });
    const deliveryCountBefore = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id },
    });

    const result = await fireTestEvent({
      tenantId: tenant.id,
      subscriptionId: "does-not-exist-99999",
      actorMembershipId: admin.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("subscription-not-found");

    const auditCountAfter = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_TESTED" },
    });
    const deliveryCountAfter = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
    expect(deliveryCountAfter).toBe(deliveryCountBefore);
  });

  it("refuses cross-tenant: tenant A cannot fire tenant B's subscription", async () => {
    const tenantB = await makeTenant("tfB");
    const adminB = await makeFirmAdmin(tenantB);
    try {
      const inB = await createSubscription({
        tenantId: tenantB.id,
        actorMembershipId: adminB.id,
        name: "tenant B receiver",
        url: "https://hooks.example.com/b",
        eventTypes: ["*"],
      });

      const result = await fireTestEvent({
        tenantId: tenant.id, // wrong tenant
        subscriptionId: inB.subscription.id,
        actorMembershipId: admin.id,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("subscription-not-found");

      // Tenant B's chain must not have an audit event written under A's
      // actor.
      const bAuditUnderAAdmin = await superDb.auditEvent.findFirst({
        where: {
          tenantId: tenantB.id,
          eventType: "WEBHOOK_SUBSCRIPTION_TESTED",
          actorMembershipId: admin.id,
        },
      });
      expect(bAuditUnderAAdmin).toBeNull();
    } finally {
      await cleanupTenant(tenantB.id);
    }
  });
});

describe("fireTestEvent — no fan-out to sibling subscriptions", () => {
  let tenant: Tenant;
  let admin: Awaited<ReturnType<typeof makeFirmAdmin>>;

  beforeEach(async () => {
    tenant = await makeTenant();
    admin = await makeFirmAdmin(tenant);
  });
  afterEach(async () => {
    await cleanupTenant(tenant.id);
  });

  it("the audit row does NOT trigger enqueueWebhooks fan-out to wildcard siblings", async () => {
    // Target subscription — will receive the test delivery.
    const target = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "target",
      url: "https://hooks.example.com/target",
      eventTypes: ["*"],
    });
    // Sibling subscription — also wildcards. If we accidentally
    // dropped the WEBHOOK_SELF_EVENT_TYPES exclusion, this would
    // ALSO get a delivery row.
    const sibling = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "sibling wildcard",
      url: "https://hooks.example.com/sibling",
      eventTypes: ["*"],
    });

    const beforeTarget = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id, subscriptionId: target.subscription.id },
    });
    const beforeSibling = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id, subscriptionId: sibling.subscription.id },
    });

    const result = await fireTestEvent({
      tenantId: tenant.id,
      subscriptionId: target.subscription.id,
      actorMembershipId: admin.id,
    });
    expect(result.ok).toBe(true);

    const afterTarget = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id, subscriptionId: target.subscription.id },
    });
    const afterSibling = await superDb.webhookDelivery.count({
      where: { tenantId: tenant.id, subscriptionId: sibling.subscription.id },
    });
    // Target gained the test delivery, sibling did not.
    expect(afterTarget).toBe(beforeTarget + 1);
    expect(afterSibling).toBe(beforeSibling);
  });
});
