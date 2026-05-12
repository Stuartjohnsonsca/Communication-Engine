/**
 * Post-PRD hardening item 72 — adherence trend (prior-period rate).
 *
 * Coverage:
 *   - prior-period rate is computed over (now-2W, now-W], NOT over the
 *     current window — current and prior never overlap.
 *   - exclusions match the firm-wide FCG block (item 66):
 *     bypassed-synth drafts and drafts without `fcgWindowDeadline`
 *     never count toward the rate.
 *   - null rate when the prior window has zero deadlined sends —
 *     same no-0/0 invariant as items 66 / 69 / 71.
 *   - cross-tenant isolation: tenant A's prior-period drafts don't
 *     leak into tenant B's rate.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  computeFcgAdherenceForRange,
  computePriorPeriodFcgRate,
} from "@/lib/drafts/rollup";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

const DAY = 24 * 60 * 60 * 1000;

async function seedDeadlinedSend(opts: {
  tenantId: string;
  membershipId: string;
  createdAt: Date;
  deadline: Date;
  sentMarkedAt: Date;
  synthesisedFromOutboundIngest?: boolean;
  fcgWindowDeadline?: Date | null;
}) {
  await superDb.draft.create({
    data: {
      tenantId: opts.tenantId,
      membershipId: opts.membershipId,
      status: "SENT",
      body: "stub",
      createdAt: opts.createdAt,
      fcgWindowDeadline:
        opts.fcgWindowDeadline === undefined ? opts.deadline : opts.fcgWindowDeadline,
      sentMarkedAt: opts.sentMarkedAt,
      synthesisedFromOutboundIngest: opts.synthesisedFromOutboundIngest ?? false,
    },
  });
}

describe("computePriorPeriodFcgRate — window scoping", () => {
  it("queries only the prior same-length window", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-scope"),
    });
    const now = new Date();

    // CURRENT window: last 7d → seed 4 within, 0 after (100% rate)
    for (let i = 0; i < 4; i += 1) {
      const created = new Date(now.getTime() - 1 * DAY);
      const deadline = new Date(now.getTime() - 0.5 * DAY);
      await seedDeadlinedSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() - 60_000),
      });
    }

    // PRIOR window: (-14d, -7d) → seed 2 within, 2 after (50% rate)
    for (let i = 0; i < 2; i += 1) {
      const created = new Date(now.getTime() - 10 * DAY);
      const deadline = new Date(now.getTime() - 9 * DAY);
      await seedDeadlinedSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() - 60_000), // within
      });
    }
    for (let i = 0; i < 2; i += 1) {
      const created = new Date(now.getTime() - 10 * DAY);
      const deadline = new Date(now.getTime() - 9 * DAY);
      await seedDeadlinedSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() + 60_000), // after
      });
    }

    const prior = await computePriorPeriodFcgRate({
      tenantId: tenant.id,
      windowDays: 7,
      now,
    });
    expect(prior.sentWithDeadline).toBe(4);
    expect(prior.sentWithinWindow).toBe(2);
    expect(prior.sentAfterWindow).toBe(2);
    expect(prior.withinWindowRate).toBe(0.5);
  });

  it("returns null rate when prior window is empty", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-empty"),
    });
    const now = new Date();

    // Only current-window data; nothing in the prior window.
    await seedDeadlinedSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: new Date(now.getTime() - 1 * DAY),
      deadline: new Date(now.getTime() - 0.5 * DAY),
      sentMarkedAt: new Date(now.getTime() - 0.6 * DAY),
    });

    const prior = await computePriorPeriodFcgRate({
      tenantId: tenant.id,
      windowDays: 7,
      now,
    });
    expect(prior.sentWithDeadline).toBe(0);
    expect(prior.withinWindowRate).toBeNull();
  });
});

describe("computeFcgAdherenceForRange — exclusions", () => {
  it("excludes bypassed-synth drafts", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-bypass"),
    });
    const now = new Date();
    const created = new Date(now.getTime() - 2 * DAY);
    const deadline = new Date(now.getTime() - 1 * DAY);

    // 1 normal within, 1 bypassed within. Rate should be 1/1 = 100%,
    // not 2/2; the bypassed row is excluded.
    await seedDeadlinedSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
    });
    await seedDeadlinedSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
      synthesisedFromOutboundIngest: true,
    });

    const r = await computeFcgAdherenceForRange({
      tenantId: tenant.id,
      since: new Date(now.getTime() - 7 * DAY),
      until: now,
    });
    expect(r.sentWithDeadline).toBe(1);
    expect(r.withinWindowRate).toBe(1);
  });

  it("excludes sends with no fcgWindowDeadline", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-no-deadline"),
    });
    const now = new Date();
    const created = new Date(now.getTime() - 2 * DAY);
    const deadline = new Date(now.getTime() - 1 * DAY);

    // 1 with deadline (within), 1 with no deadline.
    await seedDeadlinedSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
    });
    await seedDeadlinedSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
      fcgWindowDeadline: null,
    });

    const r = await computeFcgAdherenceForRange({
      tenantId: tenant.id,
      since: new Date(now.getTime() - 7 * DAY),
      until: now,
    });
    expect(r.sentWithDeadline).toBe(1);
    expect(r.withinWindowRate).toBe(1);
  });
});

describe("computePriorPeriodFcgRate — tenant isolation", () => {
  it("tenant A's prior-period drafts don't leak into tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: mA } = await createTestUserAndMembership(tenantA.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-iso-a"),
    });
    const { membership: mB } = await createTestUserAndMembership(tenantB.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("trend-iso-b"),
    });
    const now = new Date();

    // Tenant A had a bad prior week (2 after)
    for (let i = 0; i < 2; i += 1) {
      const created = new Date(now.getTime() - 10 * DAY);
      const deadline = new Date(now.getTime() - 9 * DAY);
      await seedDeadlinedSend({
        tenantId: tenantA.id,
        membershipId: mA.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() + 60_000),
      });
    }
    // Tenant B had a clean prior week (1 within)
    await seedDeadlinedSend({
      tenantId: tenantB.id,
      membershipId: mB.id,
      createdAt: new Date(now.getTime() - 10 * DAY),
      deadline: new Date(now.getTime() - 9 * DAY),
      sentMarkedAt: new Date(now.getTime() - 9.1 * DAY),
    });

    const priorB = await computePriorPeriodFcgRate({
      tenantId: tenantB.id,
      windowDays: 7,
      now,
    });
    expect(priorB.sentWithDeadline).toBe(1);
    expect(priorB.withinWindowRate).toBe(1);
  });
});
