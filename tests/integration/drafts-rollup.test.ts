/**
 * Post-PRD hardening item 56 — draft outcome rollup.
 *
 * Tests cover:
 *   - source classification: ingested vs manual_paste vs bypassed_synth
 *     based on `ingestedMessageId` + `synthesisedFromOutboundIngest`.
 *   - status totals match expected SENT / DISCARDED / open splits.
 *   - sendRate excludes open drafts (denominator is terminal only).
 *   - bypassRate is bypassed_sent / total_sent.
 *   - regeneration counts: childDrafts vs distinct-parents.
 *   - latency: avg produced→sent in minutes, ignoring non-SENT rows.
 *   - rollup is tenant-scoped: a second tenant's drafts don't leak.
 *   - window filter excludes drafts older than `windowDays`.
 *   - empty tenant returns all-zero/null shape (no throw).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { computeDraftRollup } from "@/lib/drafts/rollup";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

type SeedOpts = {
  tenantId: string;
  membershipId: string;
  status?: "PROPOSED" | "EDITED" | "ACCEPTED" | "SENT" | "DISCARDED";
  ingestedMessageId?: string | null;
  synthesisedFromOutboundIngest?: boolean;
  parentId?: string | null;
  createdAt?: Date;
  sentMarkedAt?: Date | null;
  fcgWindowDeadline?: Date | null;
};

async function seedDraft(opts: SeedOpts) {
  return superDb.draft.create({
    data: {
      tenantId: opts.tenantId,
      membershipId: opts.membershipId,
      status: opts.status ?? "PROPOSED",
      body: "stub body",
      ingestedMessageId: opts.ingestedMessageId ?? null,
      synthesisedFromOutboundIngest:
        opts.synthesisedFromOutboundIngest ?? false,
      parentId: opts.parentId ?? null,
      createdAt: opts.createdAt ?? new Date(),
      sentMarkedAt: opts.sentMarkedAt ?? null,
      fcgWindowDeadline: opts.fcgWindowDeadline ?? null,
    },
  });
}

async function seedIngestedMessage(tenantId: string, channelId: string) {
  return superDb.ingestedMessage.create({
    data: {
      tenantId,
      channelId,
      direction: "IN",
      sender: "c@example.com",
      subject: "stub",
      body: "stub",
    },
  });
}

async function seedChannel(tenantId: string) {
  return superDb.channel.create({
    data: { tenantId, kind: "GOOGLE", status: "ACTIVE" },
  });
}

describe("computeDraftRollup — source classification", () => {
  it("buckets by ingested / manual_paste / bypassed_synth", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("src"),
    });
    const channel = await seedChannel(tenant.id);
    const im = await seedIngestedMessage(tenant.id, channel.id);

    // 2 ingested, 1 manual paste, 1 bypassed_synth
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      ingestedMessageId: im.id,
    });
    const im2 = await seedIngestedMessage(tenant.id, channel.id);
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      ingestedMessageId: im2.id,
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
    }); // manual_paste
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      synthesisedFromOutboundIngest: true,
      status: "SENT",
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.totals.produced).toBe(4);
    expect(r.bySource.ingested.produced).toBe(2);
    expect(r.bySource.manual_paste.produced).toBe(1);
    expect(r.bySource.bypassed_synth.produced).toBe(1);
  });
});

describe("computeDraftRollup — status totals + sendRate", () => {
  it("send rate denominator excludes open drafts", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("rate"),
    });

    // 3 SENT, 1 DISCARDED, 2 PROPOSED (open)
    await Promise.all([
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "DISCARDED" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "PROPOSED" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "EDITED" }),
    ]);

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.totals.produced).toBe(6);
    expect(r.totals.sent).toBe(3);
    expect(r.totals.discarded).toBe(1);
    expect(r.totals.open).toBe(2);
    // 3 SENT / (3 + 1) terminal = 0.75
    expect(r.sendRate).toBe(0.75);
    expect(r.totals.byStatus.PROPOSED).toBe(1);
    expect(r.totals.byStatus.EDITED).toBe(1);
    expect(r.totals.byStatus.SENT).toBe(3);
    expect(r.totals.byStatus.DISCARDED).toBe(1);
  });

  it("returns null sendRate when there are no terminal drafts", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("no-terminal"),
    });
    await seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "PROPOSED" });
    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.sendRate).toBeNull();
  });
});

describe("computeDraftRollup — bypass rate", () => {
  it("is bypassed_sent / total_sent", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("bypass"),
    });

    // 3 regular SENT, 1 bypassed SENT → 25%
    await Promise.all([
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "SENT" }),
      seedDraft({
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "SENT",
        synthesisedFromOutboundIngest: true,
      }),
    ]);

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.bypassRate).toBe(0.25);
  });

  it("null when there are no sends yet", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("no-sends"),
    });
    await seedDraft({ tenantId: tenant.id, membershipId: membership.id, status: "PROPOSED" });
    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.bypassRate).toBeNull();
  });
});

describe("computeDraftRollup — regeneration counts", () => {
  it("distinguishes childDrafts from draftsRegeneratedAtLeastOnce", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("regen"),
    });

    // parent regenerated twice → 1 parent, 2 children
    const parent = await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "DISCARDED",
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      parentId: parent.id,
      status: "DISCARDED",
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      parentId: parent.id,
      status: "SENT",
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.regeneration.childDrafts).toBe(2);
    expect(r.regeneration.draftsRegeneratedAtLeastOnce).toBe(1);
    // 2 children / 3 produced ≈ 0.667
    expect(r.regeneration.rate).toBeCloseTo(2 / 3, 5);
  });
});

describe("computeDraftRollup — latency", () => {
  it("averages produced→sent in minutes, ignores non-SENT", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("lat"),
    });

    const base = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // 30 minutes → 30
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });
    // 90 minutes → 90, avg 60
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      sentMarkedAt: new Date(base.getTime() + 90 * 60_000),
    });
    // DISCARDED — must not affect sent latency
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "DISCARDED",
      createdAt: base,
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.latency.avgProducedToSentMin).toBe(60);
    expect(r.latency.avgProducedToDiscardedMin).toBeNull();
  });
});

describe("computeDraftRollup — tenant scoping", () => {
  it("does not leak rows from other tenants", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const a = await createTestUserAndMembership(tenantA.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("a"),
    });
    const b = await createTestUserAndMembership(tenantB.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("b"),
    });
    await seedDraft({ tenantId: tenantA.id, membershipId: a.membership.id, status: "SENT" });
    await seedDraft({ tenantId: tenantB.id, membershipId: b.membership.id, status: "SENT" });
    await seedDraft({ tenantId: tenantB.id, membershipId: b.membership.id, status: "SENT" });

    const rA = await computeDraftRollup({ tenantId: tenantA.id });
    const rB = await computeDraftRollup({ tenantId: tenantB.id });
    expect(rA.totals.sent).toBe(1);
    expect(rB.totals.sent).toBe(2);
  });
});

describe("computeDraftRollup — window filter", () => {
  it("excludes drafts older than the windowDays cutoff", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("win"),
    });
    const inside = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const outside = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: inside,
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: outside,
    });

    const r30 = await computeDraftRollup({ tenantId: tenant.id, windowDays: 30 });
    expect(r30.totals.produced).toBe(1);
    const r90 = await computeDraftRollup({ tenantId: tenant.id, windowDays: 90 });
    expect(r90.totals.produced).toBe(2);
  });
});

describe("computeDraftRollup — empty tenant", () => {
  it("returns zero-shape without throwing", async () => {
    const tenant = await createTestTenant();
    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.totals.produced).toBe(0);
    expect(r.bypassRate).toBeNull();
    expect(r.sendRate).toBeNull();
    expect(r.regeneration.rate).toBeNull();
    expect(r.latency.avgProducedToSentMin).toBeNull();
    expect(r.fcgWindow.sentWithDeadline).toBe(0);
    expect(r.fcgWindow.withinWindowRate).toBeNull();
    expect(r.byMembership).toEqual([]);
  });
});

/**
 * Post-PRD item 66 — FCG-window adherence at the firm level.
 *
 * Each test pins concrete deadlines + sentMarkedAt timestamps so the
 * assertion is exact, not floating-point-ish.
 */
describe("computeDraftRollup — FCG-window adherence (item 66)", () => {
  it("counts SENT drafts as within or after the FCG window deadline", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fcg"),
    });

    const base = new Date(Date.now() - 12 * 60 * 60 * 1000);
    // Within window: sent 30 min before deadline.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });
    // After window: sent 90 min after deadline.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 150 * 60_000),
    });
    // Sent but no deadline — excluded entirely (no promise).
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.fcgWindow.sentWithDeadline).toBe(2);
    expect(r.fcgWindow.sentWithinWindow).toBe(1);
    expect(r.fcgWindow.sentAfterWindow).toBe(1);
    expect(r.fcgWindow.withinWindowRate).toBe(0.5);
  });

  it("openOverdue counts non-terminal drafts whose deadline has passed", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fcg-open"),
    });

    const now = Date.now();
    // Two open drafts past their deadline.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "PROPOSED",
      fcgWindowDeadline: new Date(now - 60 * 60_000),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "EDITED",
      fcgWindowDeadline: new Date(now - 5 * 60 * 60_000),
    });
    // Open but deadline still in the future → not overdue.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "PROPOSED",
      fcgWindowDeadline: new Date(now + 5 * 60 * 60_000),
    });
    // DISCARDED past deadline → not counted (operator decided it was out
    // of scope; not a broken promise).
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "DISCARDED",
      fcgWindowDeadline: new Date(now - 60 * 60_000),
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.fcgWindow.openOverdue).toBe(2);
  });

  it("excludes bypassed-synth drafts from FCG-window accounting", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fcg-bypass"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    // Bypassed-synth with a deadline + late send. Must NOT contribute.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      synthesisedFromOutboundIngest: true,
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 120 * 60_000),
    });
    // Real engine send within window — the only counted row.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.fcgWindow.sentWithDeadline).toBe(1);
    expect(r.fcgWindow.sentWithinWindow).toBe(1);
    expect(r.fcgWindow.withinWindowRate).toBe(1);
  });

  it("withinWindowRate is null when no deadlined sends exist", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fcg-none"),
    });
    // SENT but no deadline.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      sentMarkedAt: new Date(),
    });
    const r = await computeDraftRollup({ tenantId: tenant.id });
    expect(r.fcgWindow.sentWithDeadline).toBe(0);
    expect(r.fcgWindow.withinWindowRate).toBeNull();
  });
});

/**
 * Post-PRD item 67 — per-Member FCG-window adherence in the top-drafters
 * breakdown. The firm-wide block (item 66) gives the rate; this lets
 * a FIRM_ADMIN see WHO is breaking the promise.
 */
describe("computeDraftRollup — per-Member FCG-window adherence (item 67)", () => {
  it("attributes adherence buckets to the owning Membership", async () => {
    const tenant = await createTestTenant();
    const a = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("a-clean"),
    });
    const b = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("b-slipping"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);

    // A: 2 within, 0 after, 0 overdue → 100%
    await seedDraft({
      tenantId: tenant.id,
      membershipId: a.membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 20 * 60_000),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: a.membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 40 * 60_000),
    });

    // B: 1 within, 2 after, 1 overdue → 33%
    await seedDraft({
      tenantId: tenant.id,
      membershipId: b.membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: b.membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 120 * 60_000),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: b.membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 180 * 60_000),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: b.membership.id,
      status: "PROPOSED",
      fcgWindowDeadline: new Date(Date.now() - 60 * 60_000),
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    const rowA = r.byMembership.find((x) => x.membershipId === a.membership.id);
    const rowB = r.byMembership.find((x) => x.membershipId === b.membership.id);
    expect(rowA?.fcgWindow.withinWindowRate).toBe(1);
    expect(rowA?.fcgWindow.sentWithDeadline).toBe(2);
    expect(rowA?.fcgWindow.openOverdue).toBe(0);
    expect(rowB?.fcgWindow.sentWithDeadline).toBe(3);
    expect(rowB?.fcgWindow.sentWithinWindow).toBe(1);
    expect(rowB?.fcgWindow.sentAfterWindow).toBe(2);
    expect(rowB?.fcgWindow.openOverdue).toBe(1);
    expect(rowB?.fcgWindow.withinWindowRate).toBeCloseTo(1 / 3, 5);
  });

  it("per-Member adherence excludes bypassed-synth too", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("bypasser"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    // The Member's bypass: a late-sent synth → must not affect adherence.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      synthesisedFromOutboundIngest: true,
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 120 * 60_000),
    });
    // The Member's only engine send — within window.
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      createdAt: base,
      fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
      sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
    });

    const r = await computeDraftRollup({ tenantId: tenant.id });
    const row = r.byMembership.find((x) => x.membershipId === membership.id);
    // produced / sent reflect all drafts (so the FIRM_ADMIN sees bypass
    // volume on the same row), but the adherence accounting only counts
    // the engine send.
    expect(row?.produced).toBe(2);
    expect(row?.sent).toBe(2);
    expect(row?.fcgWindow.sentWithDeadline).toBe(1);
    expect(row?.fcgWindow.withinWindowRate).toBe(1);
  });

  it("per-Member withinWindowRate is null when the Member has no deadlined sends", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("no-dl"),
    });
    await seedDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      sentMarkedAt: new Date(),
    });
    const r = await computeDraftRollup({ tenantId: tenant.id });
    const row = r.byMembership.find((x) => x.membershipId === membership.id);
    expect(row?.fcgWindow.sentWithDeadline).toBe(0);
    expect(row?.fcgWindow.withinWindowRate).toBeNull();
  });
});
