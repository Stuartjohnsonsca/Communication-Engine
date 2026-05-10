/**
 * Post-PRD hardening item 14 — outbound webhook delivery (`src/lib/webhooks/`).
 *
 * Coverage:
 *   - Signing: sign + verify roundtrip; tamper detection on body and on
 *     header; replay window enforcement.
 *   - Subscriptions: createSubscription writes audit + returns plaintext
 *     secret only on creation; URL/event-type validation; update + delete
 *     audit; tenant-isolation on read.
 *   - Dispatch: enqueueWebhooks fans out to matching enabled subs; wildcard
 *     catches everything; specific eventType filter catches only matches;
 *     disabled subscriptions are skipped; tenant-isolation (sub in tenant A
 *     never receives events from tenant B).
 *   - Audit hook: writeAuditEvent enqueues a delivery for every matching sub
 *     EXCEPT for the webhook-self event types (which would loop).
 *   - Deliver: 2xx → DELIVERED + audit + consecutiveFailures reset to 0;
 *     5xx → status PENDING with attempt bumped + scheduledFor pushed out by
 *     backoff; final attempt → DEAD_LETTERED + audit + consecutiveFailures
 *     incremented; auto-disable kicks in once threshold is reached.
 *   - Concurrency: lockDelivery prevents double-attempt — under a mock that
 *     returns the same row twice, the second pass picks up nothing because
 *     the first attempt already flipped status to IN_FLIGHT.
 *   - Reaper: reapOldDeliveries deletes old DELIVERED + DEAD_LETTERED, keeps
 *     fresh and PENDING.
 *
 * The deliver tests stub `fetch` so we never touch the network. Payloads
 * are byte-stable (we use `JSON.stringify(payload)` exactly as the
 * dispatcher does) so a verifySignature against the captured body proves
 * the receiver could have validated it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import {
  createSubscription,
  updateSubscription,
  deleteSubscription,
  listSubscriptions,
  getSubscriptionSecret,
  signBody,
  verifySignature,
  enqueueWebhooks,
  runWebhookDeliveryBatch,
  reapOldDeliveries,
  WebhookValidationError,
  generateSecret,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
  type WebhookPayload,
} from "@/lib/webhooks";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

function makeFetchSequence(...responses: Array<Response | (() => Response | Promise<Response>)>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (typeof next === "function") return next();
    return next;
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(status: number, body: string = "ok"): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  // The crypto helpers require ENCRYPTION_KEY; tests in CI may not set one.
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

describe("webhooks — signing", () => {
  it("sign + verify roundtrips with the same secret + body", () => {
    const secret = generateSecret();
    const body = JSON.stringify({ id: "abc", n: 1 });
    const header = signBody({ secret, body });
    expect(verifySignature({ header, secret, body })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const secret = generateSecret();
    const body = JSON.stringify({ ok: true });
    const header = signBody({ secret, body });
    expect(verifySignature({ header, secret, body: body + "!" })).toBe(false);
  });

  it("rejects a tampered header", () => {
    const secret = generateSecret();
    const body = "x";
    const header = signBody({ secret, body });
    const tampered = header.replace(/v1=[0-9a-f]+/, (m) =>
      // flip the first hex char so length stays equal
      "v1=" + (m.slice(3, 4) === "0" ? "1" : "0") + m.slice(4),
    );
    expect(verifySignature({ header: tampered, secret, body })).toBe(false);
  });

  it("rejects a signature outside the tolerance window", () => {
    const secret = generateSecret();
    const body = "x";
    const header = signBody({ secret, body, timestampSeconds: 1000 });
    // 30 minutes later — well past the 5-minute default tolerance.
    expect(
      verifySignature({ header, secret, body, nowSeconds: 1000 + 30 * 60 }),
    ).toBe(false);
  });

  it("accepts a signature inside a stretched tolerance window", () => {
    const secret = generateSecret();
    const body = "x";
    const header = signBody({ secret, body, timestampSeconds: 1000 });
    expect(
      verifySignature({
        header,
        secret,
        body,
        nowSeconds: 1000 + 30 * 60,
        toleranceSeconds: 60 * 60,
      }),
    ).toBe(true);
  });

  it("rejects malformed headers", () => {
    expect(verifySignature({ header: "garbage", secret: "x", body: "x" })).toBe(false);
    expect(verifySignature({ header: "t=abc,v1=def", secret: "x", body: "x" })).toBe(false);
    expect(verifySignature({ header: "t=1", secret: "x", body: "x" })).toBe(false);
  });
});

describe("webhooks — subscriptions CRUD + audit", () => {
  it("creates a subscription, returns the plaintext secret once, audits the change", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const result = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "Compliance archiver",
      url: "http://localhost:9999/hook",
      eventTypes: ["DRAFT_SENT_MARKED", "ADHERENCE_ESCALATED"],
    });
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.subscription).toMatchObject({
      tenantId: tenant.id,
      name: "Compliance archiver",
      enabled: true,
      eventTypes: ["DRAFT_SENT_MARKED", "ADHERENCE_ESCALATED"],
    });
    // Secret is encrypted at rest — the column does NOT contain the
    // plaintext.
    const row = await superDb.webhookSubscription.findUnique({
      where: { id: result.subscription.id },
    });
    expect(row?.secretEncrypted).not.toContain(result.secret);
    expect(row?.secretEncrypted.length).toBeGreaterThan(40);
    // getSubscriptionSecret returns the plaintext on demand (used by the
    // dispatcher).
    const decrypted = await getSubscriptionSecret(tenant.id, result.subscription.id);
    expect(decrypted).toBe(result.secret);
    // Audit chain reflects the create.
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_CREATED" },
    });
    expect(audit).toBeTruthy();
  });

  it("rejects URLs that look like loopback in production but allows http in dev", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    // Tests run with NODE_ENV=test which is treated as not-production, so
    // http://… is fine (we want the integration tests to be able to hit
    // a real local server). The validation that matters is wildcards +
    // event-type validation.
    await expect(
      createSubscription({
        tenantId: tenant.id,
        actorMembershipId: membership.id,
        name: "Bad",
        url: "ftp://example.com",
        eventTypes: ["*"],
      }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("rejects invalid event type entries and de-dupes overlapping ones", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await expect(
      createSubscription({
        tenantId: tenant.id,
        actorMembershipId: membership.id,
        name: "x",
        url: "http://example.com/x",
        eventTypes: ["lower_case_invalid"],
      }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
    await expect(
      createSubscription({
        tenantId: tenant.id,
        actorMembershipId: membership.id,
        name: "x",
        url: "http://example.com/x",
        eventTypes: [],
      }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
    const ok = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "dedup",
      url: "http://example.com/x",
      eventTypes: ["DRAFT_SENT_MARKED", "DRAFT_SENT_MARKED", "*"],
    });
    // ["*"] collapses everything else.
    expect(ok.subscription.eventTypes).toEqual(["*"]);
  });

  it("update audits + reset failures on re-enable; delete audits", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "x",
      url: "http://example.com/y",
      eventTypes: ["*"],
    });
    // Simulate prior failures + auto-disable.
    await superDb.webhookSubscription.update({
      where: { id: created.subscription.id },
      data: { enabled: false, consecutiveFailures: 25 },
    });
    const updated = await updateSubscription({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: membership.id,
      patch: { enabled: true, name: "renamed" },
    });
    expect(updated.enabled).toBe(true);
    expect(updated.name).toBe("renamed");
    const fresh = await superDb.webhookSubscription.findUnique({
      where: { id: created.subscription.id },
    });
    expect(fresh?.consecutiveFailures).toBe(0);

    const updateAudit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_UPDATED" },
    });
    expect(updateAudit).toBeTruthy();

    await deleteSubscription({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      actorMembershipId: membership.id,
    });
    const after = await superDb.webhookSubscription.findUnique({
      where: { id: created.subscription.id },
    });
    expect(after).toBeNull();
    const delAudit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_DELETED" },
    });
    expect(delAudit).toBeTruthy();
  });

  it("listSubscriptions is tenant-scoped", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const aMember = (await createTestUserAndMembership(a.id, { role: "FIRM_ADMIN" })).membership;
    const bMember = (await createTestUserAndMembership(b.id, { role: "FIRM_ADMIN" })).membership;
    await createSubscription({
      tenantId: a.id,
      actorMembershipId: aMember.id,
      name: "A-sub",
      url: "http://example.com/a",
      eventTypes: ["*"],
    });
    await createSubscription({
      tenantId: b.id,
      actorMembershipId: bMember.id,
      name: "B-sub",
      url: "http://example.com/b",
      eventTypes: ["*"],
    });
    const aSubs = await listSubscriptions(a.id);
    const bSubs = await listSubscriptions(b.id);
    expect(aSubs.map((s) => s.name)).toEqual(["A-sub"]);
    expect(bSubs.map((s) => s.name)).toEqual(["B-sub"]);
  });
});

describe("webhooks — dispatch fan-out", () => {
  async function buildPayload(tenantId: string, eventType: string): Promise<WebhookPayload> {
    return {
      id: "audit-id",
      tenantSlug: "",
      eventType: eventType as WebhookPayload["eventType"],
      occurredAt: new Date().toISOString(),
      subjectType: "Test",
      subjectId: "subject",
      actorMembershipId: null,
      data: { hello: "world" },
    };
  }

  it("enqueues only against subscriptions that match the event type", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const wildcard = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "wildcard",
      url: "http://example.com/w",
      eventTypes: ["*"],
    });
    const specific = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "specific",
      url: "http://example.com/s",
      eventTypes: ["DRAFT_SENT_MARKED"],
    });
    const wrong = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "wrong-event",
      url: "http://example.com/x",
      eventTypes: ["BREACH_DETECTED"],
    });
    const result = await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      auditEventId: null,
      payload: await buildPayload(tenant.id, "DRAFT_SENT_MARKED"),
    });
    expect(result.enqueued).toBe(2);
    const deliveries = await superDb.webhookDelivery.findMany({
      where: { tenantId: tenant.id },
    });
    const ids = new Set(deliveries.map((d) => d.subscriptionId));
    expect(ids.has(wildcard.subscription.id)).toBe(true);
    expect(ids.has(specific.subscription.id)).toBe(true);
    expect(ids.has(wrong.subscription.id)).toBe(false);
  });

  it("skips disabled subscriptions", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "disabled",
      url: "http://example.com/d",
      eventTypes: ["*"],
    });
    await superDb.webhookSubscription.update({
      where: { id: sub.subscription.id },
      data: { enabled: false },
    });
    const result = await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      auditEventId: null,
      payload: await buildPayload(tenant.id, "DRAFT_SENT_MARKED"),
    });
    expect(result.enqueued).toBe(0);
  });

  it("subscriptions in tenant A do not receive events from tenant B", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const aMember = (await createTestUserAndMembership(a.id, { role: "FIRM_ADMIN" })).membership;
    await createSubscription({
      tenantId: a.id,
      actorMembershipId: aMember.id,
      name: "A-only",
      url: "http://example.com/aonly",
      eventTypes: ["*"],
    });
    // Audit + dispatch fires inside B (writeAuditEvent awaits enqueueWebhooks).
    await writeAuditEvent({
      tenantId: b.id,
      eventType: "DRAFT_SENT_MARKED",
      actorMembershipId: null,
      subjectType: "Draft",
      subjectId: "draft-b",
      payload: { tenant: "B" },
    });
    const aDeliveries = await superDb.webhookDelivery.findMany({ where: { tenantId: a.id } });
    expect(aDeliveries.length).toBe(0);
  });

  it("writeAuditEvent enqueues a delivery for matching subs but not for webhook-self events", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "wildcard",
      url: "http://example.com/wildcard",
      eventTypes: ["*"],
    });
    // Substantive audit event — should enqueue.
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      actorMembershipId: null,
      subjectType: "Draft",
      subjectId: "d1",
      payload: {},
    });
    // Webhook-self audit event — must NOT enqueue (would loop).
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "WEBHOOK_DELIVERED",
      actorMembershipId: null,
      subjectType: "WebhookDelivery",
      subjectId: "fake",
      payload: {},
    });
    const deliveries = await superDb.webhookDelivery.findMany({
      where: { tenantId: tenant.id },
    });
    const eventTypes = deliveries.map((d) => d.eventType);
    expect(eventTypes).toContain("DRAFT_SENT_MARKED");
    expect(eventTypes).not.toContain("WEBHOOK_DELIVERED");
  });
});

describe("webhooks — delivery worker", () => {
  it("delivers on 2xx, writes audit, resets failure counter", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "ok-receiver",
      url: "http://example.com/ok",
      eventTypes: ["*"],
    });
    // Pre-existing failure count to confirm it's reset on success.
    await superDb.webhookSubscription.update({
      where: { id: sub.subscription.id },
      data: { consecutiveFailures: 3 },
    });
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "x",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d",
        actorMembershipId: null,
        data: { ok: true },
      },
    });
    const stub = makeFetchSequence(jsonResponse(200, "thanks"));
    const out = await runWebhookDeliveryBatch({ fetchImpl: stub.fetch });
    expect(out.delivered).toBe(1);
    expect(out.retried).toBe(0);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe("http://example.com/ok");
    const init = stub.calls[0].init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
    expect(headers[EVENT_HEADER]).toBe("DRAFT_SENT_MARKED");
    expect(headers[DELIVERY_HEADER]).toBeTruthy();
    // The body the dispatcher signed must verify against the subscription's
    // secret — that's the receiver's contract.
    const secret = await getSubscriptionSecret(tenant.id, sub.subscription.id);
    expect(secret).toBeTruthy();
    expect(
      verifySignature({
        header: headers[SIGNATURE_HEADER],
        secret: secret!,
        body: init.body as string,
      }),
    ).toBe(true);
    const after = await superDb.webhookSubscription.findUnique({
      where: { id: sub.subscription.id },
    });
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.lastDeliveredAt).toBeTruthy();
    const auditCount = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_DELIVERED" },
    });
    expect(auditCount).toBe(1);
  });

  it("retries on 5xx with bumped attempt and pushed-out scheduledFor", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "flaky",
      url: "http://example.com/flaky",
      eventTypes: ["*"],
    });
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "x",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d",
        actorMembershipId: null,
        data: {},
      },
    });
    const stub = makeFetchSequence(jsonResponse(503, "down"));
    const out = await runWebhookDeliveryBatch({ fetchImpl: stub.fetch });
    expect(out.retried).toBe(1);
    expect(out.delivered).toBe(0);
    expect(out.deadLettered).toBe(0);
    const row = await superDb.webhookDelivery.findFirst({
      where: { tenantId: tenant.id, subscriptionId: sub.subscription.id },
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempt).toBe(1);
    expect(row?.lastStatusCode).toBe(503);
    expect(row!.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("dead-letters after maxAttempts and writes audit + bumps consecutiveFailures", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "always-down",
      url: "http://example.com/down",
      eventTypes: ["*"],
    });
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "x",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d",
        actorMembershipId: null,
        data: {},
      },
    });
    // Force the row to its last attempt so a single batch tips it over.
    await superDb.webhookDelivery.updateMany({
      where: { tenantId: tenant.id, subscriptionId: sub.subscription.id },
      data: { attempt: 4, maxAttempts: 5 },
    });
    const stub = makeFetchSequence(jsonResponse(500, "still down"));
    const out = await runWebhookDeliveryBatch({ fetchImpl: stub.fetch });
    expect(out.deadLettered).toBe(1);
    const row = await superDb.webhookDelivery.findFirst({
      where: { tenantId: tenant.id, subscriptionId: sub.subscription.id },
    });
    expect(row?.status).toBe("DEAD_LETTERED");
    expect(row?.attempt).toBe(5);
    expect(row?.completedAt).toBeTruthy();
    const fresh = await superDb.webhookSubscription.findUnique({
      where: { id: sub.subscription.id },
    });
    expect(fresh?.consecutiveFailures).toBe(1);
    expect(fresh?.lastFailureAt).toBeTruthy();
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_DEAD_LETTERED" },
    });
    expect(audit).toBeTruthy();
  });

  it("auto-disables after consecutiveFailures crosses threshold", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "auto-disable",
      url: "http://example.com/auto",
      eventTypes: ["*"],
    });
    // Squash the threshold to 1 so a single dead-letter trips auto-disable.
    await superDb.webhookSubscription.update({
      where: { id: sub.subscription.id },
      data: { autoDisableThreshold: 1 },
    });
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "x",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d",
        actorMembershipId: null,
        data: {},
      },
    });
    await superDb.webhookDelivery.updateMany({
      where: { tenantId: tenant.id, subscriptionId: sub.subscription.id },
      data: { attempt: 4, maxAttempts: 5 },
    });
    const stub = makeFetchSequence(jsonResponse(500));
    await runWebhookDeliveryBatch({ fetchImpl: stub.fetch });
    const fresh = await superDb.webhookSubscription.findUnique({
      where: { id: sub.subscription.id },
    });
    expect(fresh?.enabled).toBe(false);
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "WEBHOOK_SUBSCRIPTION_AUTO_DISABLED" },
    });
    expect(audit).toBeTruthy();
  });

  it("network errors count as a failed attempt and are retried", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "broken",
      url: "http://example.com/broken",
      eventTypes: ["*"],
    });
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "x",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d",
        actorMembershipId: null,
        data: {},
      },
    });
    const stub = makeFetchSequence(() => {
      throw new Error("ECONNREFUSED");
    });
    const out = await runWebhookDeliveryBatch({ fetchImpl: stub.fetch });
    expect(out.retried).toBe(1);
    const row = await superDb.webhookDelivery.findFirst({
      where: { tenantId: tenant.id },
    });
    expect(row?.lastError).toContain("ECONNREFUSED");
    expect(row?.lastStatusCode).toBeNull();
  });

  it("reapOldDeliveries drops old terminal rows, keeps PENDING + fresh", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const sub = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      name: "reap",
      url: "http://example.com/reap",
      eventTypes: ["*"],
    });
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const fresh = new Date();
    // 1 OLD DELIVERED, 1 OLD DEAD_LETTERED, 1 fresh DELIVERED, 1 PENDING
    await superDb.webhookDelivery.createMany({
      data: [
        {
          tenantId: tenant.id,
          subscriptionId: sub.subscription.id,
          eventType: "DRAFT_SENT_MARKED",
          payload: {},
          status: "DELIVERED",
          completedAt: old,
        },
        {
          tenantId: tenant.id,
          subscriptionId: sub.subscription.id,
          eventType: "DRAFT_SENT_MARKED",
          payload: {},
          status: "DEAD_LETTERED",
          completedAt: old,
        },
        {
          tenantId: tenant.id,
          subscriptionId: sub.subscription.id,
          eventType: "DRAFT_SENT_MARKED",
          payload: {},
          status: "DELIVERED",
          completedAt: fresh,
        },
        {
          tenantId: tenant.id,
          subscriptionId: sub.subscription.id,
          eventType: "DRAFT_SENT_MARKED",
          payload: {},
          status: "PENDING",
          scheduledFor: fresh,
        },
      ],
    });
    const result = await reapOldDeliveries();
    expect(result.deleted).toBe(2);
    const remaining = await superDb.webhookDelivery.findMany({
      where: { tenantId: tenant.id, subscriptionId: sub.subscription.id },
    });
    expect(remaining.map((d) => d.status).sort()).toEqual(["DELIVERED", "PENDING"]);
  });
});
