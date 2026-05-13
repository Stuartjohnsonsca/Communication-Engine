/**
 * Post-PRD hardening item 78 — sentiment response-time metrics.
 *
 * Coverage:
 *   - acknowledgedRate math + null when no escalations in window.
 *   - Median + P90 TTA arithmetic.
 *   - Percentile null-on-empty: zero acked signals → medianAckMs and
 *     p90AckMs are null (not 0).
 *   - Oldest unacked picks the longest-outstanding signal IN window.
 *   - Out-of-window escalations don't contribute (windowDays filter).
 *   - Tenant isolation.
 *   - Scope filter: `assignedToMembershipId` limits to one assignee.
 *   - `formatTtaDuration` renders the brackets correctly.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  computeSentimentMetrics,
  formatTtaDuration,
} from "@/lib/sentiment/metrics";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function makeSignal(opts: {
  tenantId: string;
  assignedToMembershipId?: string | null;
  escalatedAt: Date | null;
  acknowledgedAt?: Date | null;
}) {
  return superDb.sentimentSignal.create({
    data: {
      tenantId: opts.tenantId,
      classification: "EXTREME_NEG",
      confidence: 0.9,
      isAboutFirmHandling: true,
      shouldEscalate: opts.escalatedAt !== null,
      escalatedAt: opts.escalatedAt,
      acknowledgedAt: opts.acknowledgedAt ?? null,
      assignedToMembershipId: opts.assignedToMembershipId ?? null,
    },
  });
}

const HOUR = 60 * 60 * 1000;

describe("computeSentimentMetrics — arithmetic", () => {
  it("computes acknowledgedRate, median, p90 across escalated signals", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // Five escalations in window, acked at 1h, 2h, 3h, 6h, 10h.
    const escalatedAt = new Date(now.getTime() - 24 * HOUR);
    const ackOffsets = [1, 2, 3, 6, 10];
    for (const h of ackOffsets) {
      await makeSignal({
        tenantId: tenant.id,
        escalatedAt,
        acknowledgedAt: new Date(escalatedAt.getTime() + h * HOUR),
      });
    }
    // One escalated-and-unacked in window — contributes to escalated +
    // oldestUnacked but NOT to median/p90.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 5 * HOUR),
    });

    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m.escalated).toBe(6);
    expect(m.acknowledged).toBe(5);
    expect(m.acknowledgedRate).toBeCloseTo(5 / 6, 5);
    // Median of [1,2,3,6,10]h = 3h = 3 * 3.6e6 ms
    expect(m.medianAckMs).toBe(3 * HOUR);
    // P90 of [1,2,3,6,10]h with linear-interp = at rank 3.6 between
    // 6h (idx 3) and 10h (idx 4) → 6 + 0.6*(10-6) = 8.4h
    expect(m.p90AckMs).toBeCloseTo(8.4 * HOUR, -2);
    // Oldest unacked: the one we created 5h ago.
    expect(m.oldestUnackedMs).toBeGreaterThanOrEqual(5 * HOUR - 1000);
    expect(m.oldestUnackedMs).toBeLessThanOrEqual(5 * HOUR + 60_000);
  });

  it("returns null aggregates when no escalations in window", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // A signal that was never escalated — must not contribute.
    await makeSignal({ tenantId: tenant.id, escalatedAt: null });
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m.escalated).toBe(0);
    expect(m.acknowledged).toBe(0);
    expect(m.acknowledgedRate).toBeNull();
    expect(m.medianAckMs).toBeNull();
    expect(m.p90AckMs).toBeNull();
    expect(m.oldestUnackedMs).toBeNull();
  });

  it("returns null TTA when escalated > 0 but acknowledged === 0", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 6 * HOUR),
    });
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m.escalated).toBe(1);
    expect(m.acknowledged).toBe(0);
    expect(m.acknowledgedRate).toBe(0);
    // Important: null, not 0 — we won't pretend ack was instant.
    expect(m.medianAckMs).toBeNull();
    expect(m.p90AckMs).toBeNull();
  });
});

describe("computeSentimentMetrics — window + scope", () => {
  it("excludes out-of-window escalations", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // In-window: 5d ago, acked 1h later.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - (5 * 24 - 1) * HOUR),
    });
    // Out-of-window: 60d ago. Excluded from a 30d window even though
    // it's in the table.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 60 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 60 * 24 * HOUR + 30 * HOUR),
    });

    const m30 = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m30.escalated).toBe(1);
    const m90 = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 90,
      now,
    });
    expect(m90.escalated).toBe(2);
  });

  it("scopes to a single assignee when assignedToMembershipId is set", async () => {
    const tenant = await createTestTenant();
    const mine = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("scope-mine"),
    });
    const other = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("scope-other"),
    });
    const now = new Date();
    const esc = new Date(now.getTime() - 6 * HOUR);
    // Mine: 1 acked 30m later.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: mine.membership.id,
      escalatedAt: esc,
      acknowledgedAt: new Date(esc.getTime() + 30 * 60_000),
    });
    // Other: 1 still unacked — must NOT appear in my scope.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: other.membership.id,
      escalatedAt: esc,
    });

    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      assignedToMembershipId: mine.membership.id,
      now,
    });
    expect(m.escalated).toBe(1);
    expect(m.acknowledged).toBe(1);
    expect(m.oldestUnackedMs).toBeNull();
  });

  it("tenant-scoped: tenant A's escalations don't leak into tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const now = new Date();
    await makeSignal({
      tenantId: tenantA.id,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
    });
    await makeSignal({
      tenantId: tenantB.id,
      escalatedAt: new Date(now.getTime() - 5 * HOUR),
    });

    const a = await computeSentimentMetrics({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
    });
    const b = await computeSentimentMetrics({
      tenantId: tenantB.id,
      windowDays: 30,
      now,
    });
    expect(a.escalated).toBe(1);
    expect(b.escalated).toBe(1);
    // Verify the right rows landed in the right tenant via outstanding
    // age — A's signal is 2h old, B's is 5h.
    expect(a.oldestUnackedMs).toBeLessThan(3 * HOUR);
    expect(b.oldestUnackedMs).toBeGreaterThan(4 * HOUR);
  });
});

describe("formatTtaDuration — bracket boundaries", () => {
  it("renders null as em-dash", () => {
    expect(formatTtaDuration(null)).toBe("—");
  });
  it("renders sub-minute as <1m", () => {
    expect(formatTtaDuration(30_000)).toBe("<1m");
  });
  it("renders minutes under 60 as Nm", () => {
    expect(formatTtaDuration(45 * 60_000)).toBe("45m");
  });
  it("renders hours under 48 as Nh", () => {
    expect(formatTtaDuration(12 * HOUR)).toBe("12h");
  });
  it("renders multi-day as Nd", () => {
    expect(formatTtaDuration(5 * 24 * HOUR)).toBe("5d");
  });
});
