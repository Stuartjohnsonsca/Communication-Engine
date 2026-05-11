/**
 * Audit log review UI backing query (post-PRD hardening item 20).
 *
 * Covers the filter + cursor pagination semantics that the /admin/audit page
 * relies on. The chain integrity itself is exercised by `audit-chain.test.ts`;
 * here we exclusively exercise `listAuditEvents` and `resolveAuditActor`.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  listAuditEvents,
  resolveAuditActor,
  writeAuditEvent,
} from "@/lib/audit";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

/** A unique email per test, avoids the global `User.email` unique-constraint collision. */
function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function seedEvents(
  tenantId: string,
  count: number,
  base: {
    eventType?: "USER_INVITED" | "DRAFT_PRODUCED" | "ACTION_CREATED";
    actorMembershipId?: string | null;
    subjectType?: string;
  } = {},
) {
  for (let i = 0; i < count; i++) {
    await writeAuditEvent({
      tenantId,
      eventType: base.eventType ?? "DRAFT_PRODUCED",
      actorMembershipId: base.actorMembershipId ?? null,
      subjectType: base.subjectType ?? "Draft",
      subjectId: `s-${i}`,
      payload: { i },
    });
  }
}

describe("listAuditEvents", () => {
  it("returns events newest-first and reports nextCursor when more remain", async () => {
    const t = await createTestTenant();
    await seedEvents(t.id, 7);

    const page1 = await listAuditEvents({ tenantId: t.id, limit: 3 });
    expect(page1.events.length).toBe(3);
    // seq 7,6,5
    expect(page1.events.map((e) => Number(e.seq))).toEqual([7, 6, 5]);
    expect(page1.nextCursor).toBe("5");

    const page2 = await listAuditEvents({
      tenantId: t.id,
      limit: 3,
      before: BigInt(page1.nextCursor!),
    });
    expect(page2.events.map((e) => Number(e.seq))).toEqual([4, 3, 2]);
    expect(page2.nextCursor).toBe("2");

    const page3 = await listAuditEvents({
      tenantId: t.id,
      limit: 3,
      before: BigInt(page2.nextCursor!),
    });
    expect(page3.events.map((e) => Number(e.seq))).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
  });

  it("isolates tenants — a query for tenant A never returns tenant B's events", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    await seedEvents(a.id, 4, { eventType: "USER_INVITED" });
    await seedEvents(b.id, 6, { eventType: "ACTION_CREATED" });

    const resA = await listAuditEvents({ tenantId: a.id });
    expect(resA.events.length).toBe(4);
    expect(resA.events.every((e) => e.eventType === "USER_INVITED")).toBe(true);

    const resB = await listAuditEvents({ tenantId: b.id });
    expect(resB.events.length).toBe(6);
    expect(resB.events.every((e) => e.eventType === "ACTION_CREATED")).toBe(true);
  });

  it("filters by event type, actor, subject type, and date range", async () => {
    const t = await createTestTenant();
    const { membership: m1 } = await createTestUserAndMembership(t.id);
    const { membership: m2 } = await createTestUserAndMembership(t.id);

    // 3 DRAFT_PRODUCED by m1, 2 ACTION_CREATED by m2.
    await seedEvents(t.id, 3, {
      eventType: "DRAFT_PRODUCED",
      actorMembershipId: m1.id,
      subjectType: "Draft",
    });
    await seedEvents(t.id, 2, {
      eventType: "ACTION_CREATED",
      actorMembershipId: m2.id,
      subjectType: "Action",
    });

    const byEvent = await listAuditEvents({
      tenantId: t.id,
      filters: { eventTypes: ["ACTION_CREATED"] },
    });
    expect(byEvent.events.length).toBe(2);
    expect(byEvent.events.every((e) => e.eventType === "ACTION_CREATED")).toBe(true);

    const byActor = await listAuditEvents({
      tenantId: t.id,
      filters: { actorMembershipId: m1.id },
    });
    expect(byActor.events.length).toBe(3);
    expect(byActor.events.every((e) => e.actorMembershipId === m1.id)).toBe(true);
    expect(byActor.events[0]!.actor?.user.email).toBeDefined();

    const bySubject = await listAuditEvents({
      tenantId: t.id,
      filters: { subjectType: "Action" },
    });
    expect(bySubject.events.length).toBe(2);

    // Date filter: until-cutoff before any event was written returns 0.
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const sinceFuture = await listAuditEvents({
      tenantId: t.id,
      filters: { since: future },
    });
    expect(sinceFuture.events.length).toBe(0);
    const untilPast = await listAuditEvents({
      tenantId: t.id,
      filters: { until: past },
    });
    expect(untilPast.events.length).toBe(0);
  });

  it("clamps page size and ignores nonsense limits", async () => {
    const t = await createTestTenant();
    await seedEvents(t.id, 3);
    const tiny = await listAuditEvents({ tenantId: t.id, limit: 0 });
    expect(tiny.events.length).toBe(1);
    const huge = await listAuditEvents({ tenantId: t.id, limit: 1_000_000 });
    expect(huge.events.length).toBe(3);
  });
});

describe("resolveAuditActor", () => {
  it("accepts an email and returns the membership id in the same tenant", async () => {
    const t = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(t.id, {
      email: uniqueEmail("auditor"),
    });
    const resolved = await resolveAuditActor(t.id, user.email);
    expect(resolved).toBe(membership.id);
  });

  it("accepts a raw membership id", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id);
    const resolved = await resolveAuditActor(t.id, membership.id);
    expect(resolved).toBe(membership.id);
  });

  it("returns null when no membership matches (does not throw)", async () => {
    const t = await createTestTenant();
    const resolved = await resolveAuditActor(t.id, "no-such-user@example.com");
    expect(resolved).toBeNull();
  });

  it("does not cross tenants — an email present in tenant B does not match in tenant A", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const { user } = await createTestUserAndMembership(b.id, {
      email: uniqueEmail("shared"),
    });
    const resolvedInA = await resolveAuditActor(a.id, user.email);
    expect(resolvedInA).toBeNull();
  });

  it("handles whitespace and mixed-case email tokens", async () => {
    const t = await createTestTenant();
    const lowered = uniqueEmail("case");
    const { user, membership } = await createTestUserAndMembership(t.id, {
      email: lowered,
    });
    const resolved = await resolveAuditActor(t.id, `  ${lowered.toUpperCase()}  `);
    expect(resolved).toBe(membership.id);
    void user;
  });
});
