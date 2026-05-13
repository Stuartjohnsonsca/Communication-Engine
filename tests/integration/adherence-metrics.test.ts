/**
 * Post-PRD hardening item 90 — adherence response-time metrics.
 *
 * Sister test to `sentiment-metrics.test.ts` (item 78) on the adherence
 * pillar. Coverage:
 *   - `acknowledgedRate` arithmetic + null when no escalations.
 *   - Median + P90 TTA arithmetic across acked escalations.
 *   - Null TTA when escalated > 0 but acknowledged === 0 — we don't
 *     pretend ack was instant.
 *   - Oldest unacked picks the longest-outstanding row IN window.
 *   - Out-of-window escalations don't contribute (windowDays filter).
 *   - Non-escalated rows (`escalatedAt: null`) never contribute.
 *   - Tenant isolation.
 *   - Scope filter: `membershipId` limits to one sender.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  BOOTSTRAP_MIN_N,
  bootstrapMedianCi95,
  computeAdherenceMetrics,
  computePriorPeriodAdherenceMetrics,
  MIN_SIGNALS_FLOOR,
} from "@/lib/adherence/metrics";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

const HOUR = 60 * 60 * 1000;

async function makeDraft(tenantId: string, membershipId: string) {
  return superDb.draft.create({
    data: {
      tenantId,
      membershipId,
      kind: "EMAIL",
      status: "SENT",
      channel: "EMAIL",
      subject: "Test send",
      body: "Body",
      sentText: "Body",
      sentMarkedAt: new Date(),
    },
  });
}

async function makeAdherence(opts: {
  tenantId: string;
  membershipId: string;
  overall?: number;
  escalatedAt: Date | null;
  acknowledgedAt?: Date | null;
  acknowledgedById?: string | null;
}) {
  const draft = await makeDraft(opts.tenantId, opts.membershipId);
  return superDb.communicationAdherence.create({
    data: {
      tenantId: opts.tenantId,
      draftId: draft.id,
      membershipId: opts.membershipId,
      fcgVersionUsed: 1,
      overall: opts.overall ?? 0.4,
      perDimension: {},
      perRule: [],
      escalatedAt: opts.escalatedAt,
      acknowledgedAt: opts.acknowledgedAt ?? null,
      acknowledgedById: opts.acknowledgedById ?? null,
    },
  });
}

describe("computeAdherenceMetrics — arithmetic", () => {
  it("computes acknowledgedRate, median, p90 across escalated rows", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-1"),
    });
    const now = new Date();
    // Five escalations in window, acked at 1h, 2h, 3h, 6h, 10h.
    const escalatedAt = new Date(now.getTime() - 24 * HOUR);
    const ackOffsets = [1, 2, 3, 6, 10];
    for (const h of ackOffsets) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: membership.id,
        escalatedAt,
        acknowledgedAt: new Date(escalatedAt.getTime() + h * HOUR),
        acknowledgedById: membership.id,
      });
    }
    // One escalated-and-unacked in window — contributes to escalated +
    // oldestUnacked but NOT to median/p90.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 5 * HOUR),
    });

    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m.escalated).toBe(6);
    expect(m.acknowledged).toBe(5);
    expect(m.acknowledgedRate).toBeCloseTo(5 / 6, 5);
    // Median of [1,2,3,6,10]h = 3h
    expect(m.medianAckMs).toBe(3 * HOUR);
    // P90 linear-interp between idx 3 (6h) and idx 4 (10h) at rank 3.6
    // → 6 + 0.6*(10-6) = 8.4h
    expect(m.p90AckMs).toBeCloseTo(8.4 * HOUR, -2);
    expect(m.oldestUnackedMs).toBeGreaterThanOrEqual(5 * HOUR - 1000);
    expect(m.oldestUnackedMs).toBeLessThanOrEqual(5 * HOUR + 60_000);
  });

  it("returns null aggregates when no escalations in window", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-empty"),
    });
    const now = new Date();
    // A scored-but-not-escalated row — above threshold, no escalation.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.92,
      escalatedAt: null,
    });
    const m = await computeAdherenceMetrics({
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
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-no-acks"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 6 * HOUR),
    });
    const m = await computeAdherenceMetrics({
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

describe("computeAdherenceMetrics — window + scope", () => {
  it("out-of-window escalations don't contribute", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-window"),
    });
    const now = new Date();
    // 45d ago — outside a 30d window.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 44 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    // In-window control row.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 4 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(m.escalated).toBe(1);
  });

  it("scope filter: membershipId limits to one sender", async () => {
    const tenant = await createTestTenant();
    const { membership: m1 } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-scope-1"),
    });
    const { membership: m2 } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-scope-2"),
    });
    const now = new Date();
    const escalatedAt = new Date(now.getTime() - 3 * HOUR);
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: m1.id,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + HOUR),
      acknowledgedById: m1.id,
    });
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: m2.id,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + 2 * HOUR),
      acknowledgedById: m2.id,
    });
    const firmWide = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(firmWide.escalated).toBe(2);
    expect(firmWide.medianAckMs).toBe(1.5 * HOUR);

    const mineOnly = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: m1.id,
      now,
    });
    expect(mineOnly.escalated).toBe(1);
    expect(mineOnly.medianAckMs).toBe(1 * HOUR);
  });

  it("tenant-scoped: another tenant's rows don't leak in", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: a } = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-iso-a"),
    });
    const { membership: b } = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-iso-b"),
    });
    const now = new Date();
    const escalatedAt = new Date(now.getTime() - 3 * HOUR);
    await makeAdherence({
      tenantId: tenantA.id,
      membershipId: a.id,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + 1 * HOUR),
      acknowledgedById: a.id,
    });
    await makeAdherence({
      tenantId: tenantB.id,
      membershipId: b.id,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + 5 * HOUR),
      acknowledgedById: b.id,
    });
    const rA = await computeAdherenceMetrics({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
    });
    const rB = await computeAdherenceMetrics({
      tenantId: tenantB.id,
      windowDays: 30,
      now,
    });
    expect(rA.escalated).toBe(1);
    expect(rA.medianAckMs).toBe(1 * HOUR);
    expect(rB.escalated).toBe(1);
    expect(rB.medianAckMs).toBe(5 * HOUR);
  });

  it("oldestUnackedMs is in-window only — old unacked from before doesn't dominate", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-metrics-old"),
    });
    const now = new Date();
    // 90d-old unacked — outside a 7d window, must NOT appear.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 90 * 24 * HOUR),
    });
    // In-window unacked 3h ago.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 3 * HOUR),
    });
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 7,
      now,
    });
    expect(m.escalated).toBe(1);
    expect(m.oldestUnackedMs).toBeGreaterThanOrEqual(3 * HOUR - 1000);
    expect(m.oldestUnackedMs).toBeLessThanOrEqual(3 * HOUR + 60_000);
  });
});

describe("computePriorPeriodAdherenceMetrics — item 91 trend pill source", () => {
  it("prior 30d window is [now-60d, now-30d) — current + prior never overlap", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-window"),
    });
    const now = new Date();
    // Row at exactly the cutoff (now - 30d) belongs to PRIOR (lt: now-30
    // for prior, gte: now-30 for current) — but actually our impl uses
    // [since, until) so the prior window's until = now-30 is exclusive.
    // A row escalated at exactly now-30d would belong to CURRENT, not
    // prior. Verify by placing rows on either side.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR), // prior
      acknowledgedAt: new Date(now.getTime() - 44 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR), // current
      acknowledgedAt: new Date(now.getTime() - 4 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    const cur = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    const prev = await computePriorPeriodAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(cur.escalated).toBe(1);
    expect(prev.escalated).toBe(1);
  });

  it("ack landing in current window does NOT credit prior (asOf pinned to until)", async () => {
    // Row escalated 40d ago — squarely in prior 30d window. But the ack
    // didn't land until 10d ago, which is in CURRENT. Without asOf
    // pinning, prior would see this as "acked" (inflating prior ack
    // rate); with pinning, prior sees it as "still open at window
    // close" and acknowledged is 0.
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-asof"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      // Ack inside current window:
      acknowledgedAt: new Date(now.getTime() - 10 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    const prev = await computePriorPeriodAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(prev.escalated).toBe(1);
    // Load-bearing: this is 0, NOT 1. The ack lives in the current
    // window's evidence, not the prior window's.
    expect(prev.acknowledged).toBe(0);
    expect(prev.acknowledgedRate).toBe(0);
    expect(prev.medianAckMs).toBeNull();
  });

  it("oldestUnackedMs in prior window measured at asOf=until, not now", async () => {
    // Row escalated 50d ago, never acked. If asOf were now, prior would
    // report ~50d outstanding. With asOf pinned to until (= now-30d),
    // prior reports ~20d outstanding — the age when the prior window
    // closed.
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-oldest"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 50 * 24 * HOUR),
    });
    const prev = await computePriorPeriodAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    // 50d ago → 20d outstanding at asOf=now-30d
    const TWENTY_D = 20 * 24 * HOUR;
    expect(prev.oldestUnackedMs).not.toBeNull();
    expect(prev.oldestUnackedMs!).toBeGreaterThanOrEqual(TWENTY_D - 60_000);
    expect(prev.oldestUnackedMs!).toBeLessThanOrEqual(TWENTY_D + 60_000);
  });

  it("scope filter symmetry: prior + current both honour membershipId", async () => {
    const tenant = await createTestTenant();
    const { membership: m1 } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-scope-1"),
    });
    const { membership: m2 } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-scope-2"),
    });
    const now = new Date();
    // m1: prior-window escalation
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: m1.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 39 * 24 * HOUR),
      acknowledgedById: m1.id,
    });
    // m2: prior-window escalation
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: m2.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 35 * 24 * HOUR),
      acknowledgedById: m2.id,
    });
    const prevAll = await computePriorPeriodAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    const prevMine = await computePriorPeriodAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: m1.id,
      now,
    });
    expect(prevAll.escalated).toBe(2);
    expect(prevMine.escalated).toBe(1);
  });

  it("tenant-scoped: A's prior data doesn't leak into B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: a } = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-iso-a"),
    });
    const { membership: b } = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("adh-prior-iso-b"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenantA.id,
      membershipId: a.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 45 * 24 * HOUR + 2 * HOUR),
      acknowledgedById: a.id,
    });
    await makeAdherence({
      tenantId: tenantB.id,
      membershipId: b.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 45 * 24 * HOUR + 8 * HOUR),
      acknowledgedById: b.id,
    });
    const prevA = await computePriorPeriodAdherenceMetrics({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
    });
    const prevB = await computePriorPeriodAdherenceMetrics({
      tenantId: tenantB.id,
      windowDays: 30,
      now,
    });
    expect(prevA.escalated).toBe(1);
    expect(prevA.medianAckMs).toBe(2 * HOUR);
    expect(prevB.escalated).toBe(1);
    expect(prevB.medianAckMs).toBe(8 * HOUR);
  });
});

describe("computeAdherenceMetrics — item 92 per-Member breakdown", () => {
  it("returns byMember only when withByMember is true", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-by-member-1"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 1 * HOUR),
      acknowledgedById: membership.id,
    });

    const without = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(without.byMember).toBeUndefined();

    const withIt = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(withIt.byMember).toBeDefined();
    expect(withIt.byMember).toHaveLength(1);
    expect(withIt.byMember![0]!.membershipId).toBe(membership.id);
  });

  it("per-Member counts sum EXACTLY to firm-wide totals (adherence-side invariant)", async () => {
    // Adherence rows always have a non-null `membershipId` (the sender),
    // so unlike sentiment — where unassigned signals exist — the sum
    // here MUST be exact. A drift would be a bug, not a triage-state
    // quirk. Asserted explicitly so a future schema change that
    // somehow nullable-fies `membershipId` would fail this test before
    // shipping.
    const tenant = await createTestTenant();
    const { membership: a } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-sum-a"),
    });
    const { membership: b } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-sum-b"),
    });
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: a.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
        acknowledgedById: a.id,
      });
    }
    for (let i = 0; i < 2; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: b.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    const sum = m.byMember!.reduce((acc, r) => acc + r.escalated, 0);
    expect(sum).toBe(m.escalated);
    const ackSum = m.byMember!.reduce((acc, r) => acc + r.acknowledged, 0);
    expect(ackSum).toBe(m.acknowledged);
  });

  it("flags lowVolume when a Member has fewer than MIN_SIGNALS_FLOOR escalations", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-low-vol"),
    });
    const now = new Date();
    // 2 escalations — well below the floor of 5.
    for (let i = 0; i < 2; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
        acknowledgedById: membership.id,
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.lowVolume).toBe(true);
    expect(m.byMember![0]!.escalated).toBeLessThan(MIN_SIGNALS_FLOOR);
  });

  it("does NOT flag lowVolume when a Member meets the floor", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-at-floor"),
    });
    const now = new Date();
    for (let i = 0; i < MIN_SIGNALS_FLOOR; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 20 * 60_000),
        acknowledgedById: membership.id,
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(m.byMember![0]!.lowVolume).toBe(false);
    expect(m.byMember![0]!.escalated).toBe(MIN_SIGNALS_FLOOR);
  });

  it("bootstrap CI is null below BOOTSTRAP_MIN_N acked, non-null at/above it", async () => {
    // n=2: degenerate CI ⇒ null. n=3: should produce a bracket that
    // contains the headline median (load-bearing — a CI that excludes
    // the point estimate would be a bug in the bootstrap path).
    const tenant = await createTestTenant();
    const { membership: low } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-ci-low"),
    });
    const { membership: ok } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-ci-ok"),
    });
    const now = new Date();
    // 2 acked for `low` — below BOOTSTRAP_MIN_N
    for (let i = 0; i < 2; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: low.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
        acknowledgedById: low.id,
      });
    }
    // 4 acked for `ok` — at/above BOOTSTRAP_MIN_N
    for (let i = 0; i < 4; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: ok.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 20 * 60_000),
        acknowledgedById: ok.id,
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    const lowRow = m.byMember!.find((r) => r.membershipId === low.id)!;
    const okRow = m.byMember!.find((r) => r.membershipId === ok.id)!;
    expect(lowRow.medianAckCi95).toBeNull();
    expect(okRow.medianAckCi95).not.toBeNull();
    // CI must contain the headline median — bracket and point estimate
    // share the same `percentile` definition (item 92's invariant).
    expect(okRow.medianAckCi95!.loMs).toBeLessThanOrEqual(okRow.medianAckMs!);
    expect(okRow.medianAckCi95!.hiMs).toBeGreaterThanOrEqual(okRow.medianAckMs!);
  });

  it("bootstrapMedianCi95 returns null below BOOTSTRAP_MIN_N (direct unit test)", () => {
    // Direct test of the exported helper — same seeded PRNG every time.
    const seed = () => 0.5;
    const tooFew = [60_000, 120_000];
    expect(tooFew.length).toBeLessThan(BOOTSTRAP_MIN_N);
    expect(bootstrapMedianCi95(tooFew, seed)).toBeNull();
  });

  it("self-view (membershipId set) accepts withByMember — does not need a one-row table", async () => {
    // Mirror of item 80's "self-view returns one row" invariant, but
    // expressed differently: the adherence page sets withByMember ONLY
    // on the firm-wide path. Verify the lib accepts `withByMember +
    // membershipId` together and returns a single row (defensive — a
    // future caller might combine them).
    const tenant = await createTestTenant();
    const { membership: me } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view"),
    });
    const { membership: other } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view-other"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: me.id,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 1 * HOUR),
      acknowledgedById: me.id,
    });
    // Other Member's row must NOT appear in self-view byMember.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: other.id,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 1 * HOUR),
      acknowledgedById: other.id,
    });
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: me.id,
      withByMember: true,
      now,
    });
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.membershipId).toBe(me.id);
    // The byMember row's numbers match the headline (single classifier
    // invariant — item 92 mirrors item 80's per-Member-can't-drift rule).
    expect(m.byMember![0]!.escalated).toBe(m.escalated);
    expect(m.byMember![0]!.acknowledged).toBe(m.acknowledged);
  });
});

describe("computeAdherenceMetrics — item 93 first-person self-view contract", () => {
  // /account uses `membershipId` + `withByMember: true` so the Member
  // sees their own bootstrap CI bracket on the adherence card. The lib
  // invariant — exactly one byMember row matching the headline — is
  // what the page reads via `byMember[0]` to pluck the CI. Drift here
  // breaks the self-view card. Mirrors item 81's sentiment-side tests.
  it("scoped self-view with multiple acks returns one row matching headline + non-null CI", async () => {
    const tenant = await createTestTenant();
    const { membership: me } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view-ci"),
    });
    const { membership: other } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view-ci-other"),
    });
    const now = new Date();
    // 4 of mine — above BOOTSTRAP_MIN_N so CI is computed.
    for (let i = 0; i < 4; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: me.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
        acknowledgedById: me.id,
      });
    }
    // 3 of someone else's — must not leak into my self-view.
    for (let i = 0; i < 3; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: other.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 90 * 60_000),
        acknowledgedById: other.id,
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: me.id,
      withByMember: true,
      now,
    });
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.membershipId).toBe(me.id);
    // Single-classifier invariant: byMember[0]'s numbers === headline.
    expect(m.byMember![0]!.escalated).toBe(m.escalated);
    expect(m.byMember![0]!.acknowledged).toBe(m.acknowledged);
    expect(m.byMember![0]!.medianAckMs).toBe(m.medianAckMs);
    // 4 acks >= BOOTSTRAP_MIN_N → CI computed; bracket contains the
    // median (load-bearing — page reads byMember[0].medianAckCi95).
    expect(m.byMember![0]!.medianAckCi95).not.toBeNull();
    expect(m.byMember![0]!.medianAckCi95!.loMs).toBeLessThanOrEqual(
      m.medianAckMs!,
    );
    expect(m.byMember![0]!.medianAckCi95!.hiMs).toBeGreaterThanOrEqual(
      m.medianAckMs!,
    );
  });

  it("scoped self-view with no escalations returns byMember: [] (not undefined)", async () => {
    // Item 93's page hides the card when escalated === 0, but the lib
    // contract is "withByMember=true → defined array, possibly empty."
    // Verify the empty-array shape so a future caller can rely on it
    // without a separate undefined-check branch.
    const tenant = await createTestTenant();
    const { membership: me } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view-empty"),
    });
    const now = new Date();
    // Above-threshold, non-escalated control row — must not contribute.
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: me.id,
      overall: 0.92,
      escalatedAt: null,
    });
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: me.id,
      withByMember: true,
      now,
    });
    expect(m.escalated).toBe(0);
    expect(m.byMember).toBeDefined();
    expect(m.byMember).toHaveLength(0);
  });

  it("scoped self-view with <BOOTSTRAP_MIN_N acks returns valid row but null CI", async () => {
    // Member has 2 acked escalations — below BOOTSTRAP_MIN_N. The page
    // hides the bracket and just shows the median, without the
    // bootstrap interval — bootstrap floor is preserved (n<3 = CI
    // would be degenerate). Mirrors item 81's sentiment-side case.
    const tenant = await createTestTenant();
    const { membership: me } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-self-view-low-acks"),
    });
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: me.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
        acknowledgedById: me.id,
      });
    }
    const m = await computeAdherenceMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      membershipId: me.id,
      withByMember: true,
      now,
    });
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.acknowledged).toBeLessThan(BOOTSTRAP_MIN_N);
    expect(m.byMember![0]!.medianAckMs).not.toBeNull();
    expect(m.byMember![0]!.medianAckCi95).toBeNull();
  });
});
