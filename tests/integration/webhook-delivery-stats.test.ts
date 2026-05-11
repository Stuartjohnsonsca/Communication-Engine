/**
 * Webhook delivery aggregate statistics (post-PRD hardening).
 *
 * Coverage:
 *   - Pure helpers: clampWindowHours bounds + defaults; classifyCode
 *     across every family (2xx/3xx/4xx/5xx/network/unknown).
 *   - Empty window: total=0, all buckets 0, topCodes=[].
 *   - Mixed deliveries: byStatus counts each PENDING/IN_FLIGHT/
 *     DELIVERED/DEAD_LETTERED; byCodeFamily groups correctly;
 *     topCodes sorts by count desc and includes "network" for
 *     null-status-code rows; topN cap respected.
 *   - Window filter: deliveries OLDER than the window are excluded.
 *   - Subscription isolation: stats for subscription A don't include
 *     deliveries from subscription B in the same tenant.
 *   - Tenant isolation: tenantDb scoping means stats for tenant A
 *     never include tenant B deliveries.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  getDeliveryStats,
  classifyCode,
  clampWindowHours,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  createSubscription,
} from "@/lib/webhooks";

type Tenant = Awaited<ReturnType<typeof superDb.tenant.create>>;

async function makeTenant(slugPrefix = "ds"): Promise<Tenant> {
  return superDb.tenant.create({
    data: { slug: `${slugPrefix}-${randomUUID().slice(0, 8)}`, name: "delivery-stats test" },
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

async function seedDelivery(
  tenantId: string,
  subscriptionId: string,
  opts: {
    status?: "PENDING" | "IN_FLIGHT" | "DELIVERED" | "DEAD_LETTERED";
    lastStatusCode?: number | null;
    createdAt?: Date;
  } = {},
) {
  return superDb.webhookDelivery.create({
    data: {
      tenantId,
      subscriptionId,
      eventType: "TEST",
      payload: {},
      status: opts.status ?? "DELIVERED",
      attempt: 1,
      maxAttempts: 5,
      scheduledFor: new Date(),
      lastStatusCode: opts.lastStatusCode ?? null,
      createdAt: opts.createdAt,
    },
  });
}

describe("delivery-stats pure helpers", () => {
  it("clampWindowHours: defaults, lower-bound clamp, upper-bound clamp", () => {
    expect(clampWindowHours(undefined)).toBe(DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(null)).toBe(DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(0)).toBe(DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(-1)).toBe(DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(Number.NaN)).toBe(DEFAULT_WINDOW_HOURS);
    expect(clampWindowHours(1)).toBe(1);
    expect(clampWindowHours(168)).toBe(168);
    expect(clampWindowHours(99_999)).toBe(MAX_WINDOW_HOURS);
  });

  it("classifyCode: 2xx/3xx/4xx/5xx + null=network + out-of-range=unknown", () => {
    expect(classifyCode(200)).toBe("2xx");
    expect(classifyCode(204)).toBe("2xx");
    expect(classifyCode(299)).toBe("2xx");
    expect(classifyCode(301)).toBe("3xx");
    expect(classifyCode(404)).toBe("4xx");
    expect(classifyCode(503)).toBe("5xx");
    expect(classifyCode(599)).toBe("5xx");
    expect(classifyCode(null)).toBe("network");
    expect(classifyCode(undefined)).toBe("network");
    expect(classifyCode(100)).toBe("unknown");
    expect(classifyCode(600)).toBe("unknown");
  });
});

describe("getDeliveryStats", () => {
  let tenant: Tenant;
  let admin: Awaited<ReturnType<typeof makeFirmAdmin>>;

  beforeEach(async () => {
    tenant = await makeTenant();
    admin = await makeFirmAdmin(tenant);
  });
  afterEach(async () => {
    await superDb.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
  });

  it("returns zero counts for a subscription with no deliveries", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "empty",
      url: "https://hooks.example.com/empty",
      eventTypes: ["*"],
    });

    const stats = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
    });
    expect(stats.total).toBe(0);
    expect(stats.byStatus.DELIVERED).toBe(0);
    expect(stats.byCodeFamily["2xx"]).toBe(0);
    expect(stats.topCodes).toEqual([]);
    expect(stats.windowHours).toBe(DEFAULT_WINDOW_HOURS);
  });

  it("aggregates byStatus, byCodeFamily, and topCodes correctly", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "mixed",
      url: "https://hooks.example.com/mixed",
      eventTypes: ["*"],
    });

    // 4× 200 DELIVERED, 2× 503 DEAD_LETTERED, 1× 404 DELIVERED, 1× network IN_FLIGHT, 1× PENDING (no code)
    for (let i = 0; i < 4; i++) {
      await seedDelivery(tenant.id, created.subscription.id, { status: "DELIVERED", lastStatusCode: 200 });
    }
    await seedDelivery(tenant.id, created.subscription.id, { status: "DEAD_LETTERED", lastStatusCode: 503 });
    await seedDelivery(tenant.id, created.subscription.id, { status: "DEAD_LETTERED", lastStatusCode: 503 });
    await seedDelivery(tenant.id, created.subscription.id, { status: "DELIVERED", lastStatusCode: 404 });
    await seedDelivery(tenant.id, created.subscription.id, { status: "IN_FLIGHT", lastStatusCode: null });
    await seedDelivery(tenant.id, created.subscription.id, { status: "PENDING", lastStatusCode: null });

    const stats = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
    });
    expect(stats.total).toBe(9);
    expect(stats.byStatus.DELIVERED).toBe(5);
    expect(stats.byStatus.DEAD_LETTERED).toBe(2);
    expect(stats.byStatus.IN_FLIGHT).toBe(1);
    expect(stats.byStatus.PENDING).toBe(1);

    expect(stats.byCodeFamily["2xx"]).toBe(4);
    expect(stats.byCodeFamily["4xx"]).toBe(1);
    expect(stats.byCodeFamily["5xx"]).toBe(2);
    expect(stats.byCodeFamily.network).toBe(2); // IN_FLIGHT + PENDING with null code

    // Top codes ordered by count desc: 200 (4), network (2), 503 (2), 404 (1)
    // 503 and network tie at 2; either order acceptable.
    const topMap = new Map<string, number>(
      stats.topCodes.map((c) => [String(c.code), c.count]),
    );
    expect(topMap.get("200")).toBe(4);
    expect(topMap.get("503")).toBe(2);
    expect(topMap.get("network")).toBe(2);
    expect(topMap.get("404")).toBe(1);
    // First entry is the highest count.
    expect(stats.topCodes[0]?.count).toBe(4);
    expect(stats.topCodes[0]?.code).toBe(200);
  });

  it("respects topN cap", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "many-codes",
      url: "https://hooks.example.com/many",
      eventTypes: ["*"],
    });
    // 6 different codes.
    for (const code of [200, 201, 301, 400, 404, 503]) {
      await seedDelivery(tenant.id, created.subscription.id, { lastStatusCode: code });
    }
    const stats = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      topN: 3,
    });
    expect(stats.topCodes).toHaveLength(3);
  });

  it("excludes deliveries older than the window", async () => {
    const created = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "window",
      url: "https://hooks.example.com/window",
      eventTypes: ["*"],
    });
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago
    const stale = new Date(now.getTime() - 50 * 60 * 60 * 1000); // 50h ago

    await seedDelivery(tenant.id, created.subscription.id, { lastStatusCode: 200, createdAt: recent });
    await seedDelivery(tenant.id, created.subscription.id, { lastStatusCode: 200, createdAt: stale });

    const stats24 = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      windowHours: 24,
      now,
    });
    expect(stats24.total).toBe(1);

    const stats72 = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: created.subscription.id,
      windowHours: 72,
      now,
    });
    expect(stats72.total).toBe(2);
  });

  it("isolates by subscription within the same tenant", async () => {
    const a = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "A",
      url: "https://hooks.example.com/a",
      eventTypes: ["*"],
    });
    const b = await createSubscription({
      tenantId: tenant.id,
      actorMembershipId: admin.id,
      name: "B",
      url: "https://hooks.example.com/b",
      eventTypes: ["*"],
    });
    await seedDelivery(tenant.id, a.subscription.id, { lastStatusCode: 200 });
    await seedDelivery(tenant.id, b.subscription.id, { lastStatusCode: 500 });
    await seedDelivery(tenant.id, b.subscription.id, { lastStatusCode: 500 });

    const statsA = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: a.subscription.id,
    });
    const statsB = await getDeliveryStats({
      tenantId: tenant.id,
      subscriptionId: b.subscription.id,
    });
    expect(statsA.total).toBe(1);
    expect(statsA.byCodeFamily["2xx"]).toBe(1);
    expect(statsB.total).toBe(2);
    expect(statsB.byCodeFamily["5xx"]).toBe(2);
  });

  it("isolates by tenant (RLS double-bind via tenantDb)", async () => {
    const tenantB = await makeTenant("dsB");
    const adminB = await makeFirmAdmin(tenantB);
    try {
      const inA = await createSubscription({
        tenantId: tenant.id,
        actorMembershipId: admin.id,
        name: "in-A",
        url: "https://hooks.example.com/a",
        eventTypes: ["*"],
      });
      const inB = await createSubscription({
        tenantId: tenantB.id,
        actorMembershipId: adminB.id,
        name: "in-B",
        url: "https://hooks.example.com/b",
        eventTypes: ["*"],
      });
      await seedDelivery(tenant.id, inA.subscription.id, { lastStatusCode: 200 });
      await seedDelivery(tenantB.id, inB.subscription.id, { lastStatusCode: 200 });
      await seedDelivery(tenantB.id, inB.subscription.id, { lastStatusCode: 200 });

      const statsA = await getDeliveryStats({
        tenantId: tenant.id,
        subscriptionId: inA.subscription.id,
      });
      expect(statsA.total).toBe(1);

      // Attempt to query B's subscription through A's tenant — RLS blocks.
      const statsCross = await getDeliveryStats({
        tenantId: tenant.id,
        subscriptionId: inB.subscription.id,
      });
      expect(statsCross.total).toBe(0);
    } finally {
      await superDb.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
    }
  });
});
