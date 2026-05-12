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
import { computeMemberFcgAdherence } from "@/lib/drafts";
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
