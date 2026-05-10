/**
 * Backlog item 8 — global ⌘K search palette.
 *
 * Coverage:
 *   - Tenant isolation: a search from tenant B never returns rows that
 *     belong to tenant A, even when the query matches data in both
 *     (defence-in-depth on RLS, reproduces the load-bearing invariant in
 *     the search-fanout context).
 *   - Per-membership scoping: a USER searching drafts only sees their own
 *     drafts; an FCT_MEMBER sees firm-wide.
 *   - RBAC gates: a USER does not see audit-event hits (audit:read) nor
 *     processing-activity hits (processing-map:read), even though the
 *     query matches.
 *   - Global-data sources: SubProcessor + ProcessingActivity rows are
 *     reachable when permissions allow.
 *   - Score ordering: an exact substring match in the title outranks a
 *     match in a secondary field.
 *   - Short queries (< 2 chars) skip the fan-out.
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { runSearch, scoreHit } from "@/lib/search";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

async function makeDraft(input: {
  tenantId: string;
  membershipId: string;
  subject: string;
  body?: string;
}) {
  return superDb.draft.create({
    data: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      kind: "EMAIL",
      status: "PROPOSED",
      channel: "EMAIL",
      subject: input.subject,
      body: input.body ?? "Body content",
    },
  });
}

describe("Search — tenant isolation", () => {
  it("never returns hits from another tenant", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const { membership: ma } = await createTestUserAndMembership(a.id, {
      role: "FCT_MEMBER",
      email: `iso-a-${a.id}@example.com`,
    });
    const { membership: mb } = await createTestUserAndMembership(b.id, {
      role: "FCT_MEMBER",
      email: `iso-b-${b.id}@example.com`,
    });

    // Same distinctive subject in both tenants. Tenant B must not see A's row.
    await makeDraft({ tenantId: a.id, membershipId: ma.id, subject: "AURORA project plan" });
    await makeDraft({ tenantId: b.id, membershipId: mb.id, subject: "AURORA project plan" });

    const fromB = await runSearch({ q: "AURORA", tenant: b, membership: mb });
    expect(fromB.hits.length).toBe(1);
    expect(fromB.hits[0]?.kind).toBe("draft");
    // Verify the row id belongs to tenant B by checking the underlying record.
    const row = await superDb.draft.findUnique({ where: { id: fromB.hits[0]!.id } });
    expect(row?.tenantId).toBe(b.id);
  });
});

describe("Search — per-membership scoping", () => {
  it("USER sees only their own drafts; FCT_MEMBER widens to firm-wide", async () => {
    const t = await createTestTenant();
    const { membership: alice } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: `alice-${t.id}@example.com`,
    });
    const { membership: bob } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: `bob-${t.id}@example.com`,
    });
    const { membership: fct } = await createTestUserAndMembership(t.id, {
      role: "FCT_MEMBER",
      email: `fct-${t.id}@example.com`,
    });

    await makeDraft({ tenantId: t.id, membershipId: alice.id, subject: "ALICE memo" });
    await makeDraft({ tenantId: t.id, membershipId: bob.id, subject: "BOB memo" });

    const aliceSearch = await runSearch({ q: "memo", tenant: t, membership: alice });
    const aliceDraftHits = aliceSearch.hits.filter((h) => h.kind === "draft");
    expect(aliceDraftHits.length).toBe(1);
    expect(aliceDraftHits[0]?.title).toContain("ALICE");

    const fctSearch = await runSearch({ q: "memo", tenant: t, membership: fct });
    const fctDraftHits = fctSearch.hits.filter((h) => h.kind === "draft");
    expect(fctDraftHits.length).toBe(2);
  });
});

describe("Search — RBAC gates", () => {
  it("USER does not see audit hits even when the query matches", async () => {
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: `rbac-user-${t.id}@example.com`,
    });
    const { membership: fct } = await createTestUserAndMembership(t.id, {
      role: "FCT_MEMBER",
      email: `rbac-fct-${t.id}@example.com`,
    });

    // Write an audit event to search against.
    const { writeAuditEvent } = await import("@/lib/audit");
    await writeAuditEvent({
      tenantId: t.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "rbac-fixture-subject",
      payload: { fixture: true },
    });

    const userResult = await runSearch({
      q: "rbac-fixture-subject",
      tenant: t,
      membership: user,
    });
    expect(userResult.hits.filter((h) => h.kind === "audit").length).toBe(0);

    const fctResult = await runSearch({
      q: "rbac-fixture-subject",
      tenant: t,
      membership: fct,
    });
    expect(fctResult.hits.filter((h) => h.kind === "audit").length).toBeGreaterThanOrEqual(1);
  });

  it("USER does not see processing-activity hits without processing-map:read", async () => {
    // ProcessingActivity is global; make sure at least one row exists with
    // a recognisable token so the test can match (the seeded set ships
    // "core", "xcl" etc.; "controllerprobe" is uniquely ours).
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: `pm-user-${t.id}@example.com`,
    });
    const { membership: fct } = await createTestUserAndMembership(t.id, {
      role: "FCT_MEMBER",
      email: `pm-fct-${t.id}@example.com`,
    });

    await superDb.processingActivity.create({
      data: {
        code: `pm-test-${Date.now()}`,
        ordinal: 999_000 + Math.floor(Math.random() * 1000),
        label: "controllerprobe activity",
        controller: "Tester",
        processor: "Tester",
      },
    });

    const userResult = await runSearch({
      q: "controllerprobe",
      tenant: t,
      membership: user,
    });
    expect(userResult.hits.filter((h) => h.kind === "processing-activity").length).toBe(0);

    const fctResult = await runSearch({
      q: "controllerprobe",
      tenant: t,
      membership: fct,
    });
    expect(fctResult.hits.filter((h) => h.kind === "processing-activity").length).toBeGreaterThanOrEqual(1);
  });
});

describe("Search — global sources", () => {
  it("returns sub-processor hits via universal-read switching:read", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: `sp-user-${t.id}@example.com`,
    });

    const code = `sp-search-${Date.now()}`;
    await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 99_000 + Math.floor(Math.random() * 1000),
        name: "Search Test Processor",
        role: "Probe",
        jurisdiction: "US",
        addedAt: new Date(),
        dataCategories: [],
      },
    });

    const result = await runSearch({ q: code, tenant: t, membership });
    const subHits = result.hits.filter((h) => h.kind === "sub-processor");
    expect(subHits.length).toBe(1);
    expect(subHits[0]?.href).toBe(`/${t.slug}/switching`);
  });
});

describe("Search — short queries skip fan-out", () => {
  it("returns skipped=true for queries < 2 characters", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id);
    const r1 = await runSearch({ q: "", tenant: t, membership });
    expect(r1.skipped).toBe(true);
    expect(r1.hits.length).toBe(0);
    const r2 = await runSearch({ q: "a", tenant: t, membership });
    expect(r2.skipped).toBe(true);
    expect(r2.hits.length).toBe(0);
  });
});

describe("Search — scoreHit", () => {
  it("title-substring outranks secondary-substring", () => {
    const titleHit = scoreHit({ q: "foo", title: "foo bar", secondary: ["nothing"] });
    const secondaryHit = scoreHit({ q: "foo", title: "nothing", secondary: ["foo bar"] });
    expect(titleHit).toBeGreaterThan(secondaryHit);
  });

  it("zero score when no match anywhere", () => {
    const s = scoreHit({ q: "absent", title: "alpha", secondary: ["beta"] });
    expect(s).toBe(0);
  });

  it("token-coverage scores below exact substring", () => {
    const tokens = scoreHit({ q: "two words", title: "two and words separately" });
    const exact = scoreHit({ q: "two words", title: "two words together" });
    expect(exact).toBeGreaterThan(tokens);
    expect(tokens).toBeGreaterThan(0);
  });

  it("recency adds a bonus for recent rows", () => {
    const fresh = scoreHit({
      q: "foo",
      title: "foo bar",
      recencyTs: new Date(),
    });
    const stale = scoreHit({
      q: "foo",
      title: "foo bar",
      recencyTs: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    expect(fresh).toBeGreaterThanOrEqual(stale);
  });
});
