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
  bootstrapMedianCi95,
  computePriorPeriodSentimentMetrics,
  computeSentimentMetrics,
  formatTtaDuration,
  MIN_SIGNALS_FLOOR,
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

describe("computePriorPeriodSentimentMetrics — item 79 trend pill source", () => {
  it("returns the immediately-prior same-length window only", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // Current window (30d): one escalation 5d ago.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 5 * 24 * HOUR + 1 * HOUR),
    });
    // Prior window (30d–60d ago): two escalations.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 40 * 24 * HOUR + 2 * HOUR),
    });
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 50 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 50 * 24 * HOUR + 4 * HOUR),
    });
    // Older than prior: 90d ago. Must not contribute.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 90 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 90 * 24 * HOUR + 1 * HOUR),
    });

    const current = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    const prior = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(current.escalated).toBe(1);
    expect(prior.escalated).toBe(2);
    // Prior median of [2h, 4h] = 3h (linear interp between two values).
    expect(prior.medianAckMs).toBe(3 * HOUR);
    expect(prior.acknowledgedRate).toBe(1);
  });

  it("current and prior windows never overlap (boundary check)", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // Predicate is `[since, until)`. For a 30d call:
    //   current = `[now - 30d, now)`     → includes a row at `now-30d`
    //   prior   = `[now - 60d, now-30d)` → excludes a row at `now-30d`
    // A signal escalated EXACTLY 30 days ago belongs to current only.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 30 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 29 * 24 * HOUR),
    });
    // 29d ago — clearly current.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 29 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 28 * 24 * HOUR),
    });
    // 31d ago — clearly prior.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 31 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 30 * 24 * HOUR),
    });

    const current = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    const prior = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(current.escalated).toBe(2); // boundary + 29d row
    expect(prior.escalated).toBe(1); // 31d row only
  });

  it("does not credit an acknowledgement that landed in the current window to the prior window", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // Escalated in prior window (45d ago), but acked in current window
    // (10d ago — well after prior window closed at -30d). The prior
    // pill must NOT count this as acknowledged — pinning `asOf =
    // until` of prior excludes the late ack.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 10 * 24 * HOUR),
    });
    const prior = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(prior.escalated).toBe(1);
    expect(prior.acknowledged).toBe(0);
    expect(prior.acknowledgedRate).toBe(0);
    // No acks in window → null median, not 0.
    expect(prior.medianAckMs).toBeNull();
    // The signal was unacked when the prior window closed (asOf =
    // -30d), and the escalation was at -45d, so outstanding at close
    // = 15d.
    expect(prior.oldestUnackedMs).toBeGreaterThan(14 * 24 * HOUR);
    expect(prior.oldestUnackedMs).toBeLessThan(16 * 24 * HOUR);
  });

  it("returns empty metrics when prior window has no escalations", async () => {
    const tenant = await createTestTenant();
    const now = new Date();
    // One in-current, none in prior — trend pill caller will render
    // nothing because `priorEscalated === 0`.
    await makeSignal({
      tenantId: tenant.id,
      escalatedAt: new Date(now.getTime() - 1 * HOUR),
    });
    const prior = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(prior.escalated).toBe(0);
    expect(prior.acknowledgedRate).toBeNull();
    expect(prior.medianAckMs).toBeNull();
    expect(prior.oldestUnackedMs).toBeNull();
  });

  it("scope filter applies to prior window the same way as current", async () => {
    const tenant = await createTestTenant();
    const mine = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("scope-prior-mine"),
    });
    const other = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("scope-prior-other"),
    });
    const now = new Date();
    // Mine in prior window, acked.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: mine.membership.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 40 * 24 * HOUR + 1 * HOUR),
    });
    // Other in prior window, also acked — must NOT leak into mine.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: other.membership.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 40 * 24 * HOUR + 30 * HOUR),
    });

    const mineScoped = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      assignedToMembershipId: mine.membership.id,
      now,
    });
    expect(mineScoped.escalated).toBe(1);
    expect(mineScoped.medianAckMs).toBe(1 * HOUR);
  });

  it("tenant isolation: prior window does not cross tenants", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const now = new Date();
    await makeSignal({
      tenantId: tenantA.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 45 * 24 * HOUR + 2 * HOUR),
    });
    await makeSignal({
      tenantId: tenantB.id,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 45 * 24 * HOUR + 8 * HOUR),
    });
    const a = await computePriorPeriodSentimentMetrics({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
    });
    const b = await computePriorPeriodSentimentMetrics({
      tenantId: tenantB.id,
      windowDays: 30,
      now,
    });
    expect(a.escalated).toBe(1);
    expect(a.medianAckMs).toBe(2 * HOUR);
    expect(b.escalated).toBe(1);
    expect(b.medianAckMs).toBe(8 * HOUR);
  });
});

describe("computeSentimentMetrics — item 80 per-Member breakdown", () => {
  it("returns byMember only when withByMember is true", async () => {
    const tenant = await createTestTenant();
    const m1 = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("by-member-1"),
    });
    const now = new Date();
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: m1.membership.id,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 1 * HOUR),
    });

    const without = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(without.byMember).toBeUndefined();

    const withIt = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(withIt.byMember).toBeDefined();
    expect(withIt.byMember).toHaveLength(1);
    expect(withIt.byMember![0]!.membershipId).toBe(m1.membership.id);
  });

  it("excludes unassigned signals from byMember but counts them in firm-wide totals", async () => {
    const tenant = await createTestTenant();
    const m1 = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("by-member-assigned"),
    });
    const now = new Date();
    // One assigned signal.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: m1.membership.id,
      escalatedAt: new Date(now.getTime() - 3 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 2 * HOUR),
    });
    // One UNASSIGNED signal (no `assignedToMembershipId`). Common in
    // practice for tenants whose FCG hasn't wired a default assignee.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: null,
      escalatedAt: new Date(now.getTime() - 5 * HOUR),
    });

    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    // Firm-wide totals include the unassigned signal.
    expect(m.escalated).toBe(2);
    expect(m.acknowledged).toBe(1);
    // But the byMember table only has the assigned Member.
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.membershipId).toBe(m1.membership.id);
    expect(m.byMember![0]!.escalated).toBe(1);
  });

  it("flags lowVolume when a Member has fewer than MIN_SIGNALS_FLOOR signals", async () => {
    const tenant = await createTestTenant();
    const slow = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("low-vol"),
    });
    const now = new Date();
    // 2 signals — well below the floor of 5.
    for (let i = 0; i < 2; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: slow.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
      });
    }
    const m = await computeSentimentMetrics({
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
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("at-floor"),
    });
    const now = new Date();
    for (let i = 0; i < MIN_SIGNALS_FLOOR; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: member.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 20 * 60_000),
      });
    }
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(m.byMember![0]!.lowVolume).toBe(false);
    expect(m.byMember![0]!.escalated).toBe(MIN_SIGNALS_FLOOR);
  });

  it("per-Member medians cannot drift from firm-wide totals", async () => {
    // Same classifier invariant as item 67's per-Member adherence:
    // summing the per-Member escalated counts must equal the firm-wide
    // assigned-signal count.
    const tenant = await createTestTenant();
    const a = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("drift-a"),
    });
    const b = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("drift-b"),
    });
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: a.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
      });
    }
    for (let i = 0; i < 2; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: b.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
      });
    }
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    const sum = m.byMember!.reduce((acc, r) => acc + r.escalated, 0);
    expect(sum).toBe(m.escalated); // no unassigned signals in this test
    const ackSum = m.byMember!.reduce((acc, r) => acc + r.acknowledged, 0);
    expect(ackSum).toBe(m.acknowledged);
  });
});

describe("computeSentimentMetrics — item 81 self-view with byMember", () => {
  // /account uses `assignedToMembershipId` + `withByMember: true` so
  // the Member sees their own bootstrap CI bracket. The lib invariant
  // is that byMember has exactly one row in this configuration — the
  // page reads `byMember[0]` to pluck the CI. Drift here breaks the
  // self-view card.
  it("self-view with withByMember returns exactly one byMember row", async () => {
    const tenant = await createTestTenant();
    const me = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("self-view"),
    });
    const other = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("self-view-other"),
    });
    const now = new Date();
    // 4 of mine, 3 of someone else's.
    for (let i = 0; i < 4; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: me.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 30 * 60_000),
      });
    }
    for (let i = 0; i < 3; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: other.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 2 * HOUR),
      });
    }

    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      assignedToMembershipId: me.membership.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    // Headline numbers reflect ONLY my signals (scope filter).
    expect(m.escalated).toBe(4);
    expect(m.acknowledged).toBe(4);
    // byMember has exactly one row — the page reads byMember[0].
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.membershipId).toBe(me.membership.id);
    // The byMember row's numbers match the headline (single classifier).
    expect(m.byMember![0]!.escalated).toBe(m.escalated);
    expect(m.byMember![0]!.acknowledged).toBe(m.acknowledged);
    // 4 acks >= BOOTSTRAP_MIN_N (3), so CI is computed.
    expect(m.byMember![0]!.medianAckCi95).not.toBeNull();
  });

  it("self-view with no signals returns an empty byMember array", async () => {
    // A Member who's never been assigned a sentiment signal must get
    // an empty byMember array (not undefined when withByMember=true,
    // not a synthetic zero row). The page renders nothing on the
    // self-view card when escalated === 0.
    const tenant = await createTestTenant();
    const me = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("self-view-empty"),
    });
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      assignedToMembershipId: me.membership.id,
      windowDays: 30,
      withByMember: true,
    });
    expect(m.escalated).toBe(0);
    expect(m.byMember).toBeDefined();
    expect(m.byMember).toHaveLength(0);
  });

  it("self-view with too few acks returns null CI but a valid byMember row", async () => {
    // Member has 2 acked signals — below BOOTSTRAP_MIN_N. The byMember
    // row still exists (escalated > 0) but medianAckCi95 is null. The
    // /account card renders the median without a bracket in this case.
    const tenant = await createTestTenant();
    const me = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("self-view-low-ack"),
    });
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      await makeSignal({
        tenantId: tenant.id,
        assignedToMembershipId: me.membership.id,
        escalatedAt: new Date(now.getTime() - (1 + i) * HOUR),
        acknowledgedAt: new Date(now.getTime() - (1 + i) * HOUR + 15 * 60_000),
      });
    }
    const m = await computeSentimentMetrics({
      tenantId: tenant.id,
      assignedToMembershipId: me.membership.id,
      windowDays: 30,
      withByMember: true,
      now,
    });
    expect(m.byMember).toHaveLength(1);
    expect(m.byMember![0]!.medianAckMs).not.toBeNull();
    expect(m.byMember![0]!.medianAckCi95).toBeNull();
  });
});

describe("bootstrapMedianCi95 — item 80 confidence interval", () => {
  // Deterministic seeded PRNG copy used only for this test — we test
  // the bootstrap function directly with a known seed so the
  // assertions are stable across runs.
  function makeSeed(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("returns null below BOOTSTRAP_MIN_N (n=2)", () => {
    expect(bootstrapMedianCi95([100, 200], makeSeed(1))).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(bootstrapMedianCi95([], makeSeed(1))).toBeNull();
  });

  it("returns a valid bracket containing the data range for small n", () => {
    const ci = bootstrapMedianCi95([1000, 2000, 3000], makeSeed(42));
    expect(ci).not.toBeNull();
    // CI bounds must fall inside [min, max] of the data — bootstrap
    // resamples can't conjure values outside the observed set.
    expect(ci!.loMs).toBeGreaterThanOrEqual(1000);
    expect(ci!.hiMs).toBeLessThanOrEqual(3000);
    expect(ci!.loMs).toBeLessThanOrEqual(ci!.hiMs);
  });

  it("CI is tight when n is large and values are clustered", () => {
    // 30 acks all within 5m of each other → CI should be narrow.
    const tight = Array.from({ length: 30 }, (_, i) => 600_000 + i * 10_000);
    const ci = bootstrapMedianCi95(tight, makeSeed(7));
    expect(ci).not.toBeNull();
    // Range of data is ~290s; CI width should be a small fraction.
    const width = ci!.hiMs - ci!.loMs;
    expect(width).toBeLessThan(180_000); // under 3m
  });

  it("CI is wide when n is small and values are spread", () => {
    // 4 acks across 1m → 4h.
    const spread = [60_000, 30 * 60_000, 2 * HOUR, 4 * HOUR];
    const ci = bootstrapMedianCi95(spread, makeSeed(99));
    expect(ci).not.toBeNull();
    // The CI width should be most of the data range — bootstrap on
    // 4 spread points yields a wide interval.
    const width = ci!.hiMs - ci!.loMs;
    expect(width).toBeGreaterThan(30 * 60_000); // at least 30m wide
  });

  it("is deterministic across calls with the same seed", () => {
    const data = [100, 250, 400, 800, 1600];
    const a = bootstrapMedianCi95(data, makeSeed(123));
    const b = bootstrapMedianCi95(data, makeSeed(123));
    expect(a).toEqual(b);
  });
});

describe("computePriorPeriodSentimentMetrics — item 88 byMember", () => {
  it("returns prior byMember only when withByMember is true", async () => {
    const tenant = await createTestTenant();
    const m1 = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("prior-by-1"),
    });
    const now = new Date();
    // Signal IN prior window (35d ago for a 30d call).
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: m1.membership.id,
      escalatedAt: new Date(now.getTime() - 35 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 35 * 24 * HOUR + 2 * HOUR),
    });

    const without = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(without.byMember).toBeUndefined();

    const withIt = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
      withByMember: true,
    });
    expect(withIt.byMember).toBeDefined();
    expect(withIt.byMember!).toHaveLength(1);
    const row = withIt.byMember![0]!;
    expect(row.membershipId).toBe(m1.membership.id);
    // Prior-window byMember median matches the headline median: single
    // ack at 2h.
    expect(row.medianAckMs).toBe(2 * HOUR);
  });

  it("Member with no prior-window signal is absent from prior byMember", async () => {
    const tenant = await createTestTenant();
    const m1 = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("prior-absent-1"),
    });
    const m2 = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("prior-absent-2"),
    });
    const now = new Date();
    // Only m1 has a signal IN the prior window. m2 has a CURRENT-window
    // signal but nothing prior — must NOT appear in prior byMember.
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: m1.membership.id,
      escalatedAt: new Date(now.getTime() - 35 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 35 * 24 * HOUR + 3 * HOUR),
    });
    await makeSignal({
      tenantId: tenant.id,
      assignedToMembershipId: m2.membership.id,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 5 * 24 * HOUR + 1 * HOUR),
    });

    const prior = await computePriorPeriodSentimentMetrics({
      tenantId: tenant.id,
      windowDays: 30,
      now,
      withByMember: true,
    });
    expect(prior.byMember).toBeDefined();
    const ids = prior.byMember!.map((r) => r.membershipId);
    expect(ids).toContain(m1.membership.id);
    expect(ids).not.toContain(m2.membership.id);
  });

  it("prior byMember is tenant-scoped — another tenant's signals don't leak", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const a1 = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("prior-iso-a"),
    });
    const b1 = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("prior-iso-b"),
    });
    const now = new Date();
    await makeSignal({
      tenantId: tenantA.id,
      assignedToMembershipId: a1.membership.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 40 * 24 * HOUR + 1 * HOUR),
    });
    await makeSignal({
      tenantId: tenantB.id,
      assignedToMembershipId: b1.membership.id,
      escalatedAt: new Date(now.getTime() - 40 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 40 * 24 * HOUR + 9 * HOUR),
    });

    const priorA = await computePriorPeriodSentimentMetrics({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
      withByMember: true,
    });
    const ids = priorA.byMember!.map((r) => r.membershipId);
    expect(ids).toEqual([a1.membership.id]);
    expect(priorA.byMember![0]!.medianAckMs).toBe(1 * HOUR);
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
