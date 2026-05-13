/**
 * Post-PRD hardening item 85 — auto-disable notification fan-out.
 *
 * Coverage:
 *   - Auto-disable trip fires `webhook_subscription_auto_disabled`
 *     notification to every active FIRM_ADMIN.
 *   - USER + FCT_MEMBER memberships do NOT receive the alert.
 *   - Re-enable + re-disable on the same subscription fires a FRESH
 *     notification (dedupeKey includes the trip's `disabledAt`).
 *   - Notification kind is mandatory (not in OPT_OUTABLE_KINDS).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  createSubscription,
  enqueueWebhooks,
  runWebhookDeliveryBatch,
} from "@/lib/webhooks";
import { OPT_OUTABLE_KINDS } from "@/lib/notifications/preferences";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY =
  process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

function makeFailingFetch(): typeof fetch {
  return async () =>
    new Response("down", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
}

/**
 * Drive a single subscription into auto-disable by squashing the
 * threshold to 1 and forcing the only enqueued delivery to its final
 * attempt before the run. Mirrors the existing auto-disable test in
 * webhooks.test.ts but returns the subscription id + the captured
 * audit's disabledAt so the test can assert on the notification.
 */
async function tripAutoDisable(opts: {
  tenantId: string;
  membershipId: string;
  subscriptionName: string;
}): Promise<{ subscriptionId: string }> {
  const sub = await createSubscription({
    tenantId: opts.tenantId,
    actorMembershipId: opts.membershipId,
    name: opts.subscriptionName,
    url: "http://example.com/auto",
    eventTypes: ["*"],
  });
  await superDb.webhookSubscription.update({
    where: { id: sub.subscription.id },
    data: { autoDisableThreshold: 1 },
  });
  await enqueueWebhooks({
    tenantId: opts.tenantId,
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
    where: { tenantId: opts.tenantId, subscriptionId: sub.subscription.id },
    data: { attempt: 4, maxAttempts: 5 },
  });
  await runWebhookDeliveryBatch({ fetchImpl: makeFailingFetch() });
  return { subscriptionId: sub.subscription.id };
}

describe("webhook auto-disable notification (item 85)", () => {
  it("fires webhook_subscription_auto_disabled to every active FIRM_ADMIN", async () => {
    const tenant = await createTestTenant();
    const { membership: adminA } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-a"),
    });
    const { membership: adminB } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-b"),
    });

    const { subscriptionId } = await tripAutoDisable({
      tenantId: tenant.id,
      membershipId: adminA.id,
      subscriptionName: "siem-archive",
    });

    // Subscription is disabled + audit row was written (already proven by
    // the existing webhooks.test.ts; we re-assert here to make this
    // test's preconditions explicit before checking the dispatch rows).
    const fresh = await superDb.webhookSubscription.findUnique({
      where: { id: subscriptionId },
    });
    expect(fresh?.enabled).toBe(false);
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "WEBHOOK_SUBSCRIPTION_AUTO_DISABLED",
      },
    });
    expect(audit).toBeTruthy();

    for (const m of [adminA, adminB]) {
      const dispatches = await superDb.notificationDispatch.findMany({
        where: {
          membershipId: m.id,
          kind: "webhook_subscription_auto_disabled",
        },
      });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.dedupeKey).toMatch(
        new RegExp(`^webhook-auto-disabled:${subscriptionId}:`),
      );
    }
  });

  it("USER + FCT_MEMBER memberships do not receive the alert", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-only"),
    });
    const { membership: user } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("user-only"),
    });
    const { membership: fct } = await createTestUserAndMembership(tenant.id, {
      role: "FCT_MEMBER",
      email: uniqueEmail("fct-only"),
    });

    await tripAutoDisable({
      tenantId: tenant.id,
      membershipId: admin.id,
      subscriptionName: "auto-disable-firm-admin-only",
    });

    for (const m of [user, fct]) {
      const dispatches = await superDb.notificationDispatch.findMany({
        where: {
          membershipId: m.id,
          kind: "webhook_subscription_auto_disabled",
        },
      });
      expect(dispatches).toHaveLength(0);
    }
  });

  it("re-enable + re-disable on the same subscription fires a fresh notification", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-recycle"),
    });

    // First trip → first notification.
    const { subscriptionId } = await tripAutoDisable({
      tenantId: tenant.id,
      membershipId: admin.id,
      subscriptionName: "recycle",
    });
    const firstDispatches = await superDb.notificationDispatch.findMany({
      where: {
        membershipId: admin.id,
        kind: "webhook_subscription_auto_disabled",
      },
    });
    expect(firstDispatches).toHaveLength(1);

    // Operator re-enables + the counter is reset to 0 (existing
    // subscriptions-update invariant). Force the wall clock to advance
    // beyond a 1-second boundary so the new disabledAt ISO timestamp
    // differs and the dedupeKey is fresh.
    await new Promise((r) => setTimeout(r, 1100));
    await superDb.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { enabled: true, consecutiveFailures: 0 },
    });

    // Re-enqueue + drive the second trip.
    await enqueueWebhooks({
      tenantId: tenant.id,
      eventType: "DRAFT_SENT_MARKED",
      payload: {
        id: "y",
        tenantSlug: "",
        eventType: "DRAFT_SENT_MARKED",
        occurredAt: new Date().toISOString(),
        subjectType: "Draft",
        subjectId: "d2",
        actorMembershipId: null,
        data: {},
      },
    });
    await superDb.webhookDelivery.updateMany({
      where: { tenantId: tenant.id, subscriptionId, status: "PENDING" },
      data: { attempt: 4, maxAttempts: 5 },
    });
    await runWebhookDeliveryBatch({ fetchImpl: makeFailingFetch() });

    // Second trip → second notification with a distinct dedupeKey.
    const allDispatches = await superDb.notificationDispatch.findMany({
      where: {
        membershipId: admin.id,
        kind: "webhook_subscription_auto_disabled",
      },
      orderBy: { sentAt: "asc" },
    });
    expect(allDispatches).toHaveLength(2);
    expect(allDispatches[0]!.dedupeKey).not.toBe(allDispatches[1]!.dedupeKey);

    // Both audit rows landed too.
    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "WEBHOOK_SUBSCRIPTION_AUTO_DISABLED",
      },
    });
    expect(audits).toHaveLength(2);
  });

  it("notification kind is mandatory (not in OPT_OUTABLE_KINDS)", () => {
    // Defence-in-depth: the dispatcher short-circuits opt-outable kinds
    // when a Membership has a preference row turning them off. This
    // alert MUST always send — an auto-disabled SIEM is exactly the
    // kind of silent failure that defeats integration observability.
    expect(
      (OPT_OUTABLE_KINDS as readonly string[]).includes(
        "webhook_subscription_auto_disabled",
      ),
    ).toBe(false);
  });
});
