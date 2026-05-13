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
  computeAdherenceMetrics,
  computePriorPeriodAdherenceMetrics,
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
