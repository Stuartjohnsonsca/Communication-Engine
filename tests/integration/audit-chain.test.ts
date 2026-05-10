/**
 * Audit chain integrity (PRD §6.2).
 *
 * Verifies that:
 *   1. Multiple events form a hash chain that walks cleanly from genesis.
 *   2. `verifyAuditChain` accepts a valid chain and rejects a tampered one.
 *   3. The DB trigger blocks UPDATE and DELETE so the chain cannot be
 *      retroactively rewritten.
 *   4. Each tenant's chain is independent (cross-tenant events do not
 *      perturb each other's hashes).
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { writeAuditEvent, verifyAuditChain } from "@/lib/audit";
import { createTestTenant } from "../helpers/fixtures";

describe("Audit chain", () => {
  it("walks a multi-event chain from genesis", async () => {
    const t = await createTestTenant();
    for (let i = 0; i < 5; i++) {
      await writeAuditEvent({
        tenantId: t.id,
        eventType: "USER_REAUTHORISED",
        subjectType: "Membership",
        subjectId: `m-${i}`,
        payload: { i, label: `event-${i}` },
      });
    }
    const events = await superDb.auditEvent.findMany({
      where: { tenantId: t.id },
      orderBy: { seq: "asc" },
    });
    expect(events.length).toBe(5);
    expect(events.map((e) => Number(e.seq))).toEqual([1, 2, 3, 4, 5]);
    // prevHash chains correctly
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
    }
    // verifyAuditChain reproduces every hash from genesis
    const ok = await verifyAuditChain(t.id);
    expect(ok).toEqual({ ok: true });
  });

  it("verifyAuditChain detects tampering with the payload", async () => {
    const t = await createTestTenant();
    await writeAuditEvent({
      tenantId: t.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-1",
      payload: { original: true },
    });
    await writeAuditEvent({
      tenantId: t.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-2",
      payload: { original: true },
    });

    // Tampering with an existing row triggers the audit_immutable() function
    // before the data ever changes; that's the strongest line. Test it
    // separately. To exercise verify-chain's detection path we simulate a
    // post-export tamper by recomputing the chain *over a mutated event*
    // — i.e. swap the row for one with a different payload via raw insert
    // is not possible (UNIQUE on tenantId+seq). Instead, drop the trigger
    // momentarily, mutate, verify, restore.
    await superDb.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE TRIGGER audit_no_update`);
    try {
      await superDb.$executeRawUnsafe(
        `UPDATE "AuditEvent" SET payload = '{"original":false}'::jsonb WHERE "tenantId" = $1 AND seq = 2`,
        t.id,
      );
      const result = await verifyAuditChain(t.id);
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe(2n);
    } finally {
      await superDb.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE TRIGGER audit_no_update`);
    }
  });

  it("UPDATE on AuditEvent is blocked by the immutability trigger", async () => {
    const t = await createTestTenant();
    await writeAuditEvent({
      tenantId: t.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-1",
      payload: { v: 1 },
    });
    await expect(
      superDb.$executeRawUnsafe(
        `UPDATE "AuditEvent" SET payload = '{"v":2}'::jsonb WHERE "tenantId" = $1`,
        t.id,
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("DELETE on AuditEvent is blocked by the immutability trigger", async () => {
    const t = await createTestTenant();
    await writeAuditEvent({
      tenantId: t.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-1",
      payload: { v: 1 },
    });
    await expect(
      superDb.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "tenantId" = $1`, t.id),
    ).rejects.toThrow(/append-only/i);
  });

  it("each tenant has its own independent chain", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();

    await writeAuditEvent({
      tenantId: a.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-a",
      payload: { fixture: "a" },
    });
    await writeAuditEvent({
      tenantId: b.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-b",
      payload: { fixture: "b" },
    });
    await writeAuditEvent({
      tenantId: a.id,
      eventType: "USER_REAUTHORISED",
      subjectType: "Membership",
      subjectId: "m-a2",
      payload: { fixture: "a", n: 2 },
    });

    const aEvents = await superDb.auditEvent.findMany({
      where: { tenantId: a.id },
      orderBy: { seq: "asc" },
    });
    const bEvents = await superDb.auditEvent.findMany({
      where: { tenantId: b.id },
      orderBy: { seq: "asc" },
    });
    // seqs are per-tenant (both start at 1), not global.
    expect(aEvents.map((e) => Number(e.seq))).toEqual([1, 2]);
    expect(bEvents.map((e) => Number(e.seq))).toEqual([1]);
    // both chains verify independently
    expect(await verifyAuditChain(a.id)).toEqual({ ok: true });
    expect(await verifyAuditChain(b.id)).toEqual({ ok: true });
  });
});
