/**
 * Post-PRD hardening item 69 — per-Member FCG-window adherence helper
 * for the /account self-view.
 *
 * Coverage:
 *   - bucket arithmetic (within / after / openOverdue) matches the
 *     firm-wide rule from item 66
 *   - bypassed-synth drafts excluded
 *   - no-deadline drafts excluded (filtered at the query layer)
 *   - DISCARDED past-deadline drafts excluded from openOverdue
 *   - cross-tenant isolation
 *   - withinWindowRate is null when no deadlined sends exist
 *   - windowDays filter excludes older drafts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  computeMemberFcgAdherence,
  computeMemberFcgAdherenceForRange,
  computeMemberPriorPeriodFcgRate,
} from "@/lib/drafts";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("computeMemberFcgAdherence — bucket arithmetic", () => {
  it("classifies SENT drafts as within or after the deadline", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-buckets"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    await superDb.draft.createMany({
      data: [
        // Within window (sent 30m before deadline)
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "SENT",
          body: "x",
          createdAt: base,
          fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
          sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
        },
        // After window (sent 60m after deadline)
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "SENT",
          body: "x",
          createdAt: base,
          fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
          sentMarkedAt: new Date(base.getTime() + 90 * 60_000),
        },
        // Open + overdue
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          body: "x",
          fcgWindowDeadline: new Date(Date.now() - 60 * 60_000),
        },
      ],
    });

    const r = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
    });
    expect(r.sentWithDeadline).toBe(2);
    expect(r.sentWithinWindow).toBe(1);
    expect(r.sentAfterWindow).toBe(1);
    expect(r.openOverdue).toBe(1);
    expect(r.withinWindowRate).toBe(0.5);
  });
});

describe("computeMemberFcgAdherence — exclusions", () => {
  it("excludes bypassed-synth drafts even when late and deadlined", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-bypass"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    // Bypassed-synth send, far past deadline — must not be counted.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        synthesisedFromOutboundIngest: true,
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 180 * 60_000),
      },
    });
    // One engine send within window.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 60 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 30 * 60_000),
      },
    });

    const r = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
    });
    expect(r.sentWithDeadline).toBe(1);
    expect(r.withinWindowRate).toBe(1);
  });

  it("excludes no-deadline drafts entirely", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-nodl"),
    });
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        sentMarkedAt: new Date(),
      },
    });
    const r = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
    });
    expect(r.sentWithDeadline).toBe(0);
    expect(r.openOverdue).toBe(0);
    expect(r.withinWindowRate).toBeNull();
  });

  it("DISCARDED past-deadline drafts do not contribute to openOverdue", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-discarded"),
    });
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "DISCARDED",
        body: "x",
        fcgWindowDeadline: new Date(Date.now() - 60 * 60_000),
      },
    });
    const r = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
    });
    expect(r.openOverdue).toBe(0);
    expect(r.sentWithDeadline).toBe(0);
  });
});

describe("computeMemberFcgAdherence — isolation + window", () => {
  it("is tenant-scoped + member-scoped: another tenant or member does not leak", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const a = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("a-mine"),
    });
    const otherA = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("a-other"),
    });
    const b = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("b"),
    });

    // Some else's late send (same tenant, different member).
    await superDb.draft.create({
      data: {
        tenantId: tenantA.id,
        membershipId: otherA.membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        fcgWindowDeadline: new Date(Date.now() - 2 * 60 * 60_000),
        sentMarkedAt: new Date(),
      },
    });
    // Another tenant's late send (same member id would be invalid; use B).
    await superDb.draft.create({
      data: {
        tenantId: tenantB.id,
        membershipId: b.membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        fcgWindowDeadline: new Date(Date.now() - 2 * 60 * 60_000),
        sentMarkedAt: new Date(),
      },
    });
    // Mine: 1 within.
    const base = new Date(Date.now() - 60 * 60_000);
    await superDb.draft.create({
      data: {
        tenantId: tenantA.id,
        membershipId: a.membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 10 * 60_000),
      },
    });

    const r = await computeMemberFcgAdherence({
      tenantId: tenantA.id,
      membershipId: a.membership.id,
    });
    expect(r.sentWithDeadline).toBe(1);
    expect(r.withinWindowRate).toBe(1);
    expect(r.sentAfterWindow).toBe(0);
  });

  it("windowDays filter excludes drafts older than the cutoff", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-window"),
    });
    const inside = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const outside = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await superDb.draft.createMany({
      data: [
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "SENT",
          body: "x",
          createdAt: inside,
          fcgWindowDeadline: new Date(inside.getTime() + 60 * 60_000),
          sentMarkedAt: new Date(inside.getTime() + 30 * 60_000),
        },
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "SENT",
          body: "x",
          createdAt: outside,
          fcgWindowDeadline: new Date(outside.getTime() + 60 * 60_000),
          sentMarkedAt: new Date(outside.getTime() + 30 * 60_000),
        },
      ],
    });

    const r30 = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      windowDays: 30,
    });
    expect(r30.sentWithDeadline).toBe(1);
    const r90 = await computeMemberFcgAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      windowDays: 90,
    });
    expect(r90.sentWithDeadline).toBe(2);
  });
});

/**
 * Post-PRD hardening item 73 — per-Member prior-period adherence rate.
 *
 * The same coverage the firm-wide trend helper has (item 72), one
 * scope tighter. Critical invariants:
 *   - the prior window is the immediately-prior same-length range
 *     (current and prior never overlap)
 *   - per-Member scoping isolates one Membership's prior data from
 *     another's (the trend pill is personal, not firm-wide)
 *   - same exclusions as `computeMemberFcgAdherence`: bypassed-synth
 *     and no-deadline drafts never contribute
 *   - null rate when the prior window is empty, never 0/0
 */
const DAY = 24 * 60 * 60 * 1000;

async function seedMemberSend(opts: {
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
      kind: "EMAIL",
      channel: "EMAIL",
      status: "SENT",
      body: "x",
      createdAt: opts.createdAt,
      fcgWindowDeadline:
        opts.fcgWindowDeadline === undefined
          ? opts.deadline
          : opts.fcgWindowDeadline,
      sentMarkedAt: opts.sentMarkedAt,
      synthesisedFromOutboundIngest: opts.synthesisedFromOutboundIngest ?? false,
    },
  });
}

describe("computeMemberPriorPeriodFcgRate — window scoping", () => {
  it("queries only the prior same-length window (per-Member)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("mtrend-scope"),
    });
    const now = new Date();

    // CURRENT 30d: 4 within, 0 after (100% — must NOT be counted in prior)
    for (let i = 0; i < 4; i += 1) {
      const created = new Date(now.getTime() - 1 * DAY);
      const deadline = new Date(now.getTime() - 0.5 * DAY);
      await seedMemberSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() - 60_000),
      });
    }
    // PRIOR 30d: (-60d, -30d) — 1 within, 3 after (25%)
    {
      const created = new Date(now.getTime() - 45 * DAY);
      const deadline = new Date(now.getTime() - 44 * DAY);
      await seedMemberSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() - 60_000),
      });
    }
    for (let i = 0; i < 3; i += 1) {
      const created = new Date(now.getTime() - 45 * DAY);
      const deadline = new Date(now.getTime() - 44 * DAY);
      await seedMemberSend({
        tenantId: tenant.id,
        membershipId: membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() + 60_000),
      });
    }

    const prior = await computeMemberPriorPeriodFcgRate({
      tenantId: tenant.id,
      membershipId: membership.id,
      windowDays: 30,
      now,
    });
    expect(prior.sentWithDeadline).toBe(4);
    expect(prior.sentWithinWindow).toBe(1);
    expect(prior.sentAfterWindow).toBe(3);
    expect(prior.withinWindowRate).toBe(0.25);
  });

  it("returns null rate when the Member's prior window is empty", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("mtrend-empty"),
    });
    const now = new Date();
    // Only a recent send — prior window stays empty.
    await seedMemberSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: new Date(now.getTime() - 1 * DAY),
      deadline: new Date(now.getTime() - 0.5 * DAY),
      sentMarkedAt: new Date(now.getTime() - 0.6 * DAY),
    });
    const prior = await computeMemberPriorPeriodFcgRate({
      tenantId: tenant.id,
      membershipId: membership.id,
      windowDays: 30,
      now,
    });
    expect(prior.sentWithDeadline).toBe(0);
    expect(prior.withinWindowRate).toBeNull();
  });
});

describe("computeMemberFcgAdherenceForRange — exclusions + scope", () => {
  it("excludes bypassed-synth + no-deadline rows", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("mtrend-bypass"),
    });
    const now = new Date();
    const created = new Date(now.getTime() - 40 * DAY);
    const deadline = new Date(now.getTime() - 39 * DAY);

    // 1 normal within, 1 bypassed-synth within, 1 no-deadline.
    await seedMemberSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
    });
    await seedMemberSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
      synthesisedFromOutboundIngest: true,
    });
    await seedMemberSend({
      tenantId: tenant.id,
      membershipId: membership.id,
      createdAt: created,
      deadline,
      sentMarkedAt: new Date(deadline.getTime() - 60_000),
      fcgWindowDeadline: null,
    });

    const r = await computeMemberFcgAdherenceForRange({
      tenantId: tenant.id,
      membershipId: membership.id,
      since: new Date(now.getTime() - 60 * DAY),
      until: new Date(now.getTime() - 30 * DAY),
    });
    expect(r.sentWithDeadline).toBe(1);
    expect(r.withinWindowRate).toBe(1);
  });

  it("is per-Member scoped — another member's prior drafts don't leak", async () => {
    const tenant = await createTestTenant();
    const a = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("mtrend-iso-a"),
    });
    const other = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("mtrend-iso-other"),
    });
    const now = new Date();

    // Other member had a bad prior month (2 after).
    for (let i = 0; i < 2; i += 1) {
      const created = new Date(now.getTime() - 45 * DAY);
      const deadline = new Date(now.getTime() - 44 * DAY);
      await seedMemberSend({
        tenantId: tenant.id,
        membershipId: other.membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() + 60_000),
      });
    }
    // Mine in the prior window: 1 within → my rate is 100%, not 33%.
    {
      const created = new Date(now.getTime() - 45 * DAY);
      const deadline = new Date(now.getTime() - 44 * DAY);
      await seedMemberSend({
        tenantId: tenant.id,
        membershipId: a.membership.id,
        createdAt: created,
        deadline,
        sentMarkedAt: new Date(deadline.getTime() - 60_000),
      });
    }

    const prior = await computeMemberPriorPeriodFcgRate({
      tenantId: tenant.id,
      membershipId: a.membership.id,
      windowDays: 30,
      now,
    });
    expect(prior.sentWithDeadline).toBe(1);
    expect(prior.withinWindowRate).toBe(1);
  });
});
