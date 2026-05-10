/**
 * Cron sweep idempotency.
 *
 * Every cron entry point must be safe to call multiple times. The PRD assumes
 * Railway cron may fire twice on a flaky run; the lifecycle, billing-close,
 * and termination sweeps must therefore produce the same final state on
 * second invocation.
 *
 * For each sweep we:
 *   1. Set up the precondition (a member due for anonymisation, a tenant due
 *      for billing close, a tenant past its termination effective date).
 *   2. Run the sweep once and capture the audit-event tail.
 *   3. Run it again and assert no new audit events appear and counts are
 *      stable.
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { runLifecycleSweep, markLeaver } from "@/lib/lifecycle";
import {
  closeAllDueBillingPeriods,
  previousPeriod,
  periodForDate,
} from "@/lib/billing";
import { runHardDeletionSweep, generateExportPackage } from "@/lib/termination";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

async function tailAudit(tenantId: string) {
  return superDb.auditEvent.findMany({
    where: { tenantId },
    orderBy: { seq: "asc" },
    select: { seq: true, eventType: true },
  });
}

describe("Cron idempotency", () => {
  it("lifecycle sweep is a no-op on second run", async () => {
    const t = await createTestTenant();
    const { membership: actor } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
    });
    const { membership: leaver } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });

    // Mark the second member as a leaver, then back-date the deadline so the
    // sweep is due to anonymise them.
    await markLeaver({
      tenantId: t.id,
      membershipId: leaver.id,
      actorMembershipId: actor.id,
      note: "test",
    });
    await superDb.membership.update({
      where: { id: leaver.id },
      data: { anonymiseDueAt: new Date(Date.now() - 60_000) },
    });

    const first = await runLifecycleSweep({ tenantId: t.id });
    expect(first.leaverExpired).toBe(1);
    const tailAfterFirst = await tailAudit(t.id);

    const second = await runLifecycleSweep({ tenantId: t.id });
    expect(second).toEqual({ revokedExpired: 0, leaverExpired: 0, ucgsAnonymised: 0 });
    const tailAfterSecond = await tailAudit(t.id);
    expect(tailAfterSecond.map((e) => Number(e.seq))).toEqual(
      tailAfterFirst.map((e) => Number(e.seq)),
    );
  });

  it("billing close sweep is a no-op on second run for the same period", async () => {
    const t = await createTestTenant();
    await createTestUserAndMembership(t.id, { role: "FIRM_ADMIN" });

    // The sweep closes the previous calendar month for every active tenant
    // — including the freshly-created one. We don't need a billable user;
    // a zero-billable period still closes.
    const period = previousPeriod(periodForDate(new Date()));

    const first = await closeAllDueBillingPeriods();
    const closedFirst = first.closed.find((c) => c.tenantId === t.id);
    expect(closedFirst).toBeDefined();
    expect(closedFirst?.period).toBe(period);

    const second = await closeAllDueBillingPeriods();
    expect(second.closed.find((c) => c.tenantId === t.id)).toBeUndefined();
    expect(second.skipped.find((s) => s.tenantId === t.id)?.reason).toMatch(/already closed/i);

    const periods = await superDb.billingPeriod.findMany({
      where: { tenantId: t.id, period },
    });
    expect(periods.length).toBe(1);
    expect(periods[0]?.status).toBe("CLOSED");

    // Audit chain has exactly one BILLING_PERIOD_CLOSED for this period.
    const events = await superDb.auditEvent.findMany({
      where: { tenantId: t.id, eventType: "BILLING_PERIOD_CLOSED" },
    });
    expect(events.length).toBe(1);
  });

  it("termination hard-deletion sweep is a no-op on second run", async () => {
    const t = await createTestTenant();
    const { membership: actor } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
    });

    // Generate an export package + put the tenant past its termination
    // effective date so the sweep is due.
    await generateExportPackage({
      tenantId: t.id,
      actorMembershipId: actor.id,
    });
    await superDb.tenant.update({
      where: { id: t.id },
      data: {
        status: "TERMINATING",
        terminationNoticeAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        terminationByName: "test",
        terminationReason: "test",
        terminationEffectiveAt: new Date(Date.now() - 60_000),
      },
    });

    const first = await runHardDeletionSweep();
    const hit = first.tenants.find((x) => x.tenantId === t.id);
    expect(hit, "first sweep should have processed the test tenant").toBeDefined();

    // After deletion, the tenant row remains (audit + DPIA retention) with
    // status TERMINATED and a terminationCompletedAt.
    const after = await superDb.tenant.findUnique({ where: { id: t.id } });
    expect(after?.status).toBe("TERMINATED");
    expect(after?.terminationCompletedAt).toBeTruthy();

    // Tail of the audit chain after sweep 1.
    const tailAfterFirst = await tailAudit(t.id);

    const second = await runHardDeletionSweep();
    expect(second.tenants.find((x) => x.tenantId === t.id)).toBeUndefined();

    const tailAfterSecond = await tailAudit(t.id);
    expect(tailAfterSecond.map((e) => Number(e.seq))).toEqual(
      tailAfterFirst.map((e) => Number(e.seq)),
    );
  });
});
