/**
 * RLS tenant isolation — the load-bearing security invariant.
 *
 * For every model in `prisma/rls.sql`'s tenant_tables array, a query made
 * with the GUC `app.current_tenant` set to tenant B MUST return zero rows
 * that belong to tenant A, even when no `where: { tenantId }` filter is
 * given. RLS is the last line of defence if a route forgets to scope.
 *
 * We exercise three representative tables (Membership, Draft, AuditEvent)
 * end-to-end here; the exhaustive coverage that every tenant_tables entry
 * is queried via tenantDb is in `rls-tenant-tables-coverage.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

describe("RLS tenant isolation", () => {
  it("blocks cross-tenant Membership reads", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    await createTestUserAndMembership(a.id, { email: `a-${a.id}@example.com` });
    await createTestUserAndMembership(b.id, { email: `b-${b.id}@example.com` });

    const dbA = tenantDb(a.id);
    const dbB = tenantDb(b.id);

    const fromA = await dbA.membership.findMany();
    const fromB = await dbB.membership.findMany();

    expect(fromA.length).toBe(1);
    expect(fromB.length).toBe(1);
    expect(fromA.every((m) => m.tenantId === a.id)).toBe(true);
    expect(fromB.every((m) => m.tenantId === b.id)).toBe(true);
  });

  it("blocks Membership reads even when the query specifies the other tenant's id", async () => {
    // Defence-in-depth case: a buggy route that scopes to the wrong tenantId
    // must still hit zero rows because RLS evaluates against the GUC, not the
    // WHERE clause.
    const a = await createTestTenant();
    const b = await createTestTenant();
    await createTestUserAndMembership(a.id);

    const dbB = tenantDb(b.id);
    const leak = await dbB.membership.findMany({ where: { tenantId: a.id } });
    expect(leak).toEqual([]);
  });

  it("blocks cross-tenant AuditEvent reads", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    await writeAuditEvent({
      tenantId: a.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "fixture-a",
      payload: { fixture: "a" },
    });
    await writeAuditEvent({
      tenantId: b.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "fixture-b",
      payload: { fixture: "b" },
    });

    const seenByA = await tenantDb(a.id).auditEvent.findMany();
    expect(seenByA.length).toBe(1);
    expect(seenByA[0]?.tenantId).toBe(a.id);
  });

  it("blocks cross-tenant Draft writes (WITH CHECK clause)", async () => {
    // The RLS policy has WITH CHECK ("tenantId" = current_setting(...)). An
    // attempt to insert a Draft with another tenant's tenantId from inside
    // tenant B's GUC must error.
    const a = await createTestTenant();
    const b = await createTestTenant();
    const { membership: memberB } = await createTestUserAndMembership(b.id);

    const dbB = tenantDb(b.id);
    await expect(
      dbB.draft.create({
        data: {
          tenantId: a.id, // wrong tenant — must be rejected
          membershipId: memberB.id,
          channel: "EMAIL",
          subject: "leak attempt",
          body: "leak attempt",
        },
      }),
    ).rejects.toThrow();
  });

  it("superDb sees all tenants (the documented escape hatch)", async () => {
    // Sanity: the audit-export and Acumon-admin paths rely on superDb seeing
    // across tenants. If this regresses, those paths break.
    const a = await createTestTenant();
    const b = await createTestTenant();
    await createTestUserAndMembership(a.id);
    await createTestUserAndMembership(b.id);

    const all = await superDb.membership.findMany({
      where: { tenantId: { in: [a.id, b.id] } },
    });
    expect(all.length).toBe(2);
  });
});
