/**
 * Post-PRD hardening item 46 — webhook signing-secret rotation.
 *
 * Coverage:
 *   - `rotateSubscriptionSecret` returns a fresh plaintext secret, moves
 *     the current encrypted blob into the previous slot, and stamps
 *     `secretPrevRetiresAt` at +graceWindowHours.
 *   - Grace window is clamped to [1h, 168h] regardless of caller input.
 *   - Audit event `WEBHOOK_SUBSCRIPTION_SECRET_ROTATED` is written and
 *     does NOT carry any secret material in the payload.
 *   - `getSubscriptionSecrets` returns both during grace and only
 *     `current` after retiresAt.
 *   - `clearRetiredPreviousSecrets` nulls expired prev blobs.
 *   - `signBodyMulti` produces a header with one `v1=` per secret;
 *     `verifySignature` accepts either secret during the grace window.
 *   - The delivery worker signs with both secrets while prev is active
 *     so a receiver running the OLD secret still verifies the body.
 *   - Rotating again replaces the in-flight prev with the most recent
 *     current secret (no three-secret window).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  createSubscription,
  rotateSubscriptionSecret,
  getSubscriptionSecret,
  getSubscriptionSecrets,
  clearRetiredPreviousSecrets,
  enqueueWebhooks,
  runWebhookDeliveryBatch,
  signBody,
  signBodyMulti,
  verifySignature,
  SIGNATURE_HEADER,
} from "@/lib/webhooks";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("signing — multi-secret header", () => {
  it("signBody (single secret) stays one v1 segment, byte-compatible with v1 receivers", () => {
    const header = signBody({ secret: "abc", body: '{"a":1}', timestampSeconds: 1700000000 });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]+$/);
    // exactly one v1=
    expect(header.match(/v1=/g)?.length).toBe(1);
  });

  it("signBodyMulti emits one v1 per secret in the given order", () => {
    const header = signBodyMulti({
      secrets: ["alpha", "beta"],
      body: "payload",
      timestampSeconds: 1700000000,
    });
    expect(header.startsWith("t=1700000000,")).toBe(true);
    expect(header.match(/v1=/g)?.length).toBe(2);
  });

  it("verifySignature accepts a body signed with either listed secret", () => {
    const header = signBodyMulti({
      secrets: ["current", "previous"],
      body: "payload",
      timestampSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verifySignature({ header, secret: "current", body: "payload" })).toBe(true);
    expect(verifySignature({ header, secret: "previous", body: "payload" })).toBe(true);
    expect(verifySignature({ header, secret: "wrong", body: "payload" })).toBe(false);
  });

  it("verifySignature rejects when body has been tampered", () => {
    const header = signBodyMulti({
      secrets: ["k1", "k2"],
      body: "payload",
      timestampSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verifySignature({ header, secret: "k1", body: "tampered" })).toBe(false);
  });
});

describe("rotateSubscriptionSecret", () => {
  async function makeSub() {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, { role: "FIRM_ADMIN", email: uniqueEmail("fa") });
    const created = await createSubscription({
      tenantId: t.id,
      actorMembershipId: membership.id,
      name: "rot",
      url: "http://127.0.0.1:9999/hook",
      eventTypes: ["DRAFT_SENT_MARKED"],
    });
    return { tenant: t, membership, subId: created.subscription.id, originalSecret: created.secret };
  }

  it("returns a fresh secret distinct from the old; old becomes the previous slot", async () => {
    const { tenant, membership, subId, originalSecret } = await makeSub();

    const rot = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 24,
    });
    expect(rot.secret).not.toBe(originalSecret);
    expect(rot.subscription.id).toBe(subId);

    const currentAfter = await getSubscriptionSecret(tenant.id, subId);
    expect(currentAfter).toBe(rot.secret);

    const pair = await getSubscriptionSecrets(tenant.id, subId);
    expect(pair).toBeTruthy();
    expect(pair!.current).toBe(rot.secret);
    expect(pair!.previous).toBe(originalSecret);
  });

  it("clamps graceWindowHours to [1, 168]", async () => {
    const { tenant, membership, subId } = await makeSub();
    const tooBig = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 10_000,
    });
    const maxDelta = tooBig.prevRetiresAt.getTime() - Date.now();
    expect(maxDelta).toBeLessThanOrEqual(168 * 60 * 60 * 1000 + 1000);
    expect(maxDelta).toBeGreaterThan(167 * 60 * 60 * 1000);

    const tooSmall = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 0,
    });
    const minDelta = tooSmall.prevRetiresAt.getTime() - Date.now();
    expect(minDelta).toBeGreaterThan(59 * 60 * 1000);
    expect(minDelta).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it("writes WEBHOOK_SUBSCRIPTION_SECRET_ROTATED with no secret material", async () => {
    const { tenant, membership, subId } = await makeSub();
    const rot = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 6,
    });
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_SECRET_ROTATED" },
      orderBy: { seq: "desc" },
    });
    expect(audit).toBeTruthy();
    const payloadStr = JSON.stringify(audit!.payload);
    expect(payloadStr).not.toContain(rot.secret);
    const payload = audit!.payload as { graceWindowHours: number; prevRetiresAt: string };
    expect(payload.graceWindowHours).toBe(6);
    expect(payload.prevRetiresAt).toBe(rot.prevRetiresAt.toISOString());
  });

  it("rotating again replaces the in-flight prev (no three-secret window)", async () => {
    const { tenant, membership, subId, originalSecret } = await makeSub();
    const first = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 48,
    });
    const second = await rotateSubscriptionSecret({
      tenantId: tenant.id,
      subscriptionId: subId,
      actorMembershipId: membership.id,
      graceWindowHours: 12,
    });
    const pair = await getSubscriptionSecrets(tenant.id, subId);
    expect(pair!.current).toBe(second.secret);
    // The "previous" slot now holds `first.secret`, NOT `originalSecret`.
    expect(pair!.previous).toBe(first.secret);
    expect(pair!.previous).not.toBe(originalSecret);
  });
});

describe("getSubscriptionSecrets — grace window lifecycle", () => {
  it("returns only current after retiresAt has passed", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, { role: "FIRM_ADMIN", email: uniqueEmail("rotex") });
    const created = await createSubscription({
      tenantId: t.id,
      actorMembershipId: membership.id,
      name: "expired",
      url: "http://127.0.0.1:9999/hook",
      eventTypes: ["DRAFT_SENT_MARKED"],
    });
    await rotateSubscriptionSecret({
      tenantId: t.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: membership.id,
      graceWindowHours: 1,
    });
    // Past the retire instant: previous should be suppressed.
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const pair = await getSubscriptionSecrets(t.id, created.subscription.id, future);
    expect(pair!.previous).toBeNull();
  });

  it("clearRetiredPreviousSecrets nulls expired prev blobs", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, { role: "FIRM_ADMIN", email: uniqueEmail("rotsweep") });
    const created = await createSubscription({
      tenantId: t.id,
      actorMembershipId: membership.id,
      name: "sweep",
      url: "http://127.0.0.1:9999/hook",
      eventTypes: ["DRAFT_SENT_MARKED"],
    });
    await rotateSubscriptionSecret({
      tenantId: t.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: membership.id,
      graceWindowHours: 1,
    });
    // Force the retire instant into the past so the sweep claims it.
    await superDb.webhookSubscription.update({
      where: { id: created.subscription.id },
      data: { secretPrevRetiresAt: new Date(Date.now() - 60_000) },
    });
    const r = await clearRetiredPreviousSecrets();
    expect(r.cleared).toBeGreaterThanOrEqual(1);
    const after = await superDb.webhookSubscription.findUnique({
      where: { id: created.subscription.id },
      select: { secretEncryptedPrev: true, secretPrevRetiresAt: true },
    });
    expect(after?.secretEncryptedPrev).toBeNull();
    expect(after?.secretPrevRetiresAt).toBeNull();
  });
});

describe("delivery — dual-signs during grace window", () => {
  it("emits a header with both current + previous v1 signatures while prev is active", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, { role: "FIRM_ADMIN", email: uniqueEmail("dual") });
    const created = await createSubscription({
      tenantId: t.id,
      actorMembershipId: membership.id,
      name: "dual",
      url: "http://127.0.0.1:9999/hook",
      eventTypes: ["DRAFT_SENT_MARKED"],
    });
    const rot = await rotateSubscriptionSecret({
      tenantId: t.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: membership.id,
      graceWindowHours: 24,
    });
    const oldSecret = created.secret;
    const newSecret = rot.secret;

    // Enqueue a single delivery to this subscription only.
    await enqueueWebhooks({
      tenantId: t.id,
      eventType: "DRAFT_SENT_MARKED",
      auditEventId: "dummy-audit",
      payload: {
        id: "evt-1",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d1",
        actorMembershipId: null,
        data: { hello: "world" },
      },
    });

    let capturedHeader: string | null = null;
    let capturedBody: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedHeader = String(
        (init?.headers as Record<string, string>)?.[SIGNATURE_HEADER],
      );
      capturedBody = typeof init?.body === "string" ? init.body : null;
      void input;
      return new Response("ok", { status: 200 });
    };

    await runWebhookDeliveryBatch({
      fetchImpl,
      // SSRF check happens at delivery time; stub DNS to allow 127.0.0.1.
      lookupImpl: async () => ({ address: "203.0.113.1", family: 4 }),
    });

    expect(capturedHeader).toBeTruthy();
    expect(capturedBody).toBeTruthy();
    expect((capturedHeader as unknown as string).match(/v1=/g)?.length).toBe(2);

    // A receiver running EITHER the old OR the new secret accepts the body.
    expect(
      verifySignature({
        header: capturedHeader as unknown as string,
        secret: newSecret,
        body: capturedBody as unknown as string,
      }),
    ).toBe(true);
    expect(
      verifySignature({
        header: capturedHeader as unknown as string,
        secret: oldSecret,
        body: capturedBody as unknown as string,
      }),
    ).toBe(true);
  });
});
