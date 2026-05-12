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
    expect(r.byMembership).toEqual([]);
  });
});
