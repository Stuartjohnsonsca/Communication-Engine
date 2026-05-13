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
import { computeAdherenceMetrics } from "@/lib/adherence/metrics";
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
