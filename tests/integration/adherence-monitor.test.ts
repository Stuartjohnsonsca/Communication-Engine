/**
 * Post-PRD hardening item 71 — firm-adherence escalation cron.
 *
 * Coverage:
 *   - below threshold + above volume floor → notification + audit fire,
 *     deduped per ISO week so a second cron run is a no-op.
 *   - above threshold → no notification, no audit, no dispatch row.
 *   - below threshold but below volume floor → no notification (volume
 *     floor stops near-empty tenants from tripping the alert).
 *   - no deadlined sends → no_data short-circuit (never trips).
 *   - notification kind is mandatory: a preference row trying to mute
 *     it has no effect (defence-in-depth on the dispatcher).
 *   - cross-tenant isolation: tenant A's bad week doesn't touch tenant B.
 *   - FIRM_ADMIN-only recipient list: USER and FCT_MEMBER memberships
 *     don't receive the alert.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  evaluateTenantAdherence,
  runAdherenceMonitor,
  ADHERENCE_THRESHOLD,
  MIN_DEADLINED_SENDS,
  WINDOW_DAYS,
} from "@/lib/drafts/adherence-monitor";
import { isoWeekKey } from "@/lib/notifications/digest";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

/**
 * Seed N deadlined-and-sent drafts: `withinCount` within the window,
 * `afterCount` past the window. All `createdAt` inside `WINDOW_DAYS`.
 */
async function seedDeadlinedSends(opts: {
  tenantId: string;
  membershipId: string;
  withinCount: number;
  afterCount: number;
}) {
  const baseCreatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1d ago
  const baseDeadline = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago

  for (let i = 0; i < opts.withinCount; i += 1) {
    // sentMarkedAt before deadline → "within"
    await superDb.draft.create({
      data: {
        tenantId: opts.tenantId,
        membershipId: opts.membershipId,
        status: "SENT",
        body: "stub",
        createdAt: baseCreatedAt,
        fcgWindowDeadline: baseDeadline,
        sentMarkedAt: new Date(baseDeadline.getTime() - 60_000), // 1m before deadline
      },
    });
  }
  for (let i = 0; i < opts.afterCount; i += 1) {
    // sentMarkedAt past deadline → "after"
    await superDb.draft.create({
      data: {
        tenantId: opts.tenantId,
        membershipId: opts.membershipId,
        status: "SENT",
        body: "stub",
        createdAt: baseCreatedAt,
        fcgWindowDeadline: baseDeadline,
        sentMarkedAt: new Date(baseDeadline.getTime() + 60_000), // 1m late
      },
    });
  }
}

describe("adherence-monitor — threshold + dedupe", () => {
  it("fires alert + audit when rate below threshold and above volume floor", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-low"),
    });

    // 6 within, 6 after → 50% over 12 sends. Below 80% threshold, above
    // the volume floor of 10.
    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: admin.id,
      withinCount: 6,
      afterCount: 6,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.sentWithDeadline).toBe(12);
    expect(outcome.sentWithinWindow).toBe(6);
    expect(outcome.sentAfterWindow).toBe(6);
    expect(outcome.withinWindowRate).toBe(0.5);
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    // Dispatch row exists with the ISO-week dedupeKey.
    const week = isoWeekKey(new Date());
    const dispatch = await superDb.notificationDispatch.findUnique({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: admin.id,
          kind: "firm_adherence_below_threshold",
          dedupeKey: `firm-adherence-below:${week}`,
        },
      },
    });
    expect(dispatch).not.toBeNull();

    // Audit row landed on the tenant's chain.
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_BELOW_THRESHOLD",
      },
    });
    expect(audit).not.toBeNull();

    // Second run inside the same week → already_alerted_this_week, no
    // additional dispatch, no additional audit.
    const second = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(second.result).toBe("already_alerted_this_week");

    const dispatchCount = await superDb.notificationDispatch.count({
      where: {
        tenantId: tenant.id,
        kind: "firm_adherence_below_threshold",
      },
    });
    expect(dispatchCount).toBe(1);

    const auditCount = await superDb.auditEvent.count({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_BELOW_THRESHOLD",
      },
    });
    expect(auditCount).toBe(1);
  });

  it("does not fire when rate is above threshold", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-high"),
    });

    // 11 within, 1 after → ~92% over 12 sends. Above 80% threshold.
    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: admin.id,
      withinCount: 11,
      afterCount: 1,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("above_threshold");
    if (outcome.result !== "above_threshold") throw new Error("unreachable");
    expect(outcome.sentWithDeadline).toBe(12);
    expect(outcome.withinWindowRate).toBeGreaterThan(ADHERENCE_THRESHOLD);

    const dispatchCount = await superDb.notificationDispatch.count({
      where: { tenantId: tenant.id, kind: "firm_adherence_below_threshold" },
    });
    expect(dispatchCount).toBe(0);

    const auditCount = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "FIRM_ADHERENCE_BELOW_THRESHOLD" },
    });
    expect(auditCount).toBe(0);
  });

  it("does not fire when below threshold but below volume floor", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-low-vol"),
    });

    // 1 within, 2 after → 33% over 3 sends. Rate is bad but volume
    // (3) is well below MIN_DEADLINED_SENDS (10).
    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: admin.id,
      withinCount: 1,
      afterCount: 2,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("skipped_low_volume");
    if (outcome.result !== "skipped_low_volume") throw new Error("unreachable");
    expect(outcome.sentWithDeadline).toBe(3);
    expect(outcome.sentWithDeadline).toBeLessThan(MIN_DEADLINED_SENDS);

    const dispatchCount = await superDb.notificationDispatch.count({
      where: { tenantId: tenant.id, kind: "firm_adherence_below_threshold" },
    });
    expect(dispatchCount).toBe(0);
  });

  it("no_data when tenant has no deadlined sends", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-no-data"),
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("no_data");
  });
});

describe("adherence-monitor — recipient scoping", () => {
  it("only notifies FIRM_ADMIN memberships, not USER or FCT_MEMBER", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-only"),
    });
    const { membership: user } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("user-skip"),
    });
    const { membership: fct } = await createTestUserAndMembership(tenant.id, {
      role: "FCT_MEMBER",
      email: uniqueEmail("fct-skip"),
    });

    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: admin.id,
      withinCount: 4,
      afterCount: 8,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    const userDispatches = await superDb.notificationDispatch.count({
      where: {
        membershipId: { in: [user.id, fct.id] },
        kind: "firm_adherence_below_threshold",
      },
    });
    expect(userDispatches).toBe(0);
  });

  it("ignores tenants with no FIRM_ADMIN (no_data)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("user-only"),
    });

    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: membership.id,
      withinCount: 4,
      afterCount: 8,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("no_data");
  });
});

describe("adherence-monitor — tenant isolation", () => {
  it("tenant A's bad week does not trigger tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: adminA } = await createTestUserAndMembership(tenantA.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-a"),
    });
    const { membership: adminB } = await createTestUserAndMembership(tenantB.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-b"),
    });

    // Tenant A is bad
    await seedDeadlinedSends({
      tenantId: tenantA.id,
      membershipId: adminA.id,
      withinCount: 3,
      afterCount: 9,
    });
    // Tenant B is good
    await seedDeadlinedSends({
      tenantId: tenantB.id,
      membershipId: adminB.id,
      withinCount: 12,
      afterCount: 0,
    });

    const run = await runAdherenceMonitor();
    const aOutcome = run.perTenant.find((p) => p.tenantId === tenantA.id);
    const bOutcome = run.perTenant.find((p) => p.tenantId === tenantB.id);
    expect(aOutcome?.outcome.result).toBe("alerted");
    expect(bOutcome?.outcome.result).toBe("above_threshold");

    // No cross-tenant dispatch row.
    const bDispatches = await superDb.notificationDispatch.count({
      where: { tenantId: tenantB.id, kind: "firm_adherence_below_threshold" },
    });
    expect(bDispatches).toBe(0);
    const aDispatches = await superDb.notificationDispatch.count({
      where: { tenantId: tenantA.id, kind: "firm_adherence_below_threshold" },
    });
    expect(aDispatches).toBe(1);
  });
});

describe("adherence-monitor — mandatory kind", () => {
  it("ignores a preference row trying to mute the alert", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-mute"),
    });

    // Try to mute by direct preference row insertion — the dispatcher's
    // `isOptOutable` gate should short-circuit any read.
    await superDb.membershipNotificationPreference.create({
      data: {
        tenantId: tenant.id,
        membershipId: admin.id,
        kind: "firm_adherence_below_threshold",
        emailEnabled: false,
      },
    });

    await seedDeadlinedSends({
      tenantId: tenant.id,
      membershipId: admin.id,
      withinCount: 4,
      afterCount: 8,
    });

    const outcome = await evaluateTenantAdherence({ tenantId: tenant.id });
    expect(outcome.result).toBe("alerted");

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { tenantId: tenant.id, kind: "firm_adherence_below_threshold" },
    });
    // Mandatory kind — status is never SKIPPED_USER_PREFERENCE.
    expect(dispatch?.status).not.toBe("SKIPPED_USER_PREFERENCE");
  });
});

describe("adherence-monitor — constants invariants", () => {
  it("window matches the firm-rollup short window", () => {
    // The cron computes a 7d rate to match the /admin/drafts default
    // short window. If this changes, /admin/drafts and the alert can
    // drift — pin it.
    expect(WINDOW_DAYS).toBe(7);
  });

  it("threshold is sane", () => {
    expect(ADHERENCE_THRESHOLD).toBeGreaterThan(0);
    expect(ADHERENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("min volume floor is at least 2 (statistical sanity)", () => {
    expect(MIN_DEADLINED_SENDS).toBeGreaterThanOrEqual(2);
  });
});
