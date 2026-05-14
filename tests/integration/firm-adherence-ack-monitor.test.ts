/**
 * Post-PRD hardening item 95 — firm-wide adherence-escalation ack-rate
 * cron. Adherence-pillar analog of item 84's `firm-ack-monitor.test.ts`.
 *
 * Coverage mirrors item 84 + adds two adherence-pillar-specific
 * invariants:
 *   - below threshold + above volume floor → notification + audit fire,
 *     deduped per ISO week so a second cron run is a no-op.
 *   - above threshold → no notification, no audit, no dispatch row.
 *   - below threshold but below volume floor → skipped_low_volume.
 *   - no escalations → no_data short-circuit.
 *   - cross-tenant isolation.
 *   - FIRM_ADMIN-only recipient list.
 *   - notification kind is mandatory (not in OPT_OUTABLE_KINDS).
 *   - constants pinned.
 *   - **dedupe namespace is DISTINCT from item 71's
 *     `firm-adherence-below:` slot** — the two adherence-pillar firm
 *     alerts must be able to fire in the same week without colliding,
 *     because they measure different questions (FCG-window adherence
 *     vs ack-rate on already-escalated rows).
 *   - **scope predicate uses `membershipId` (sender)**, not
 *     `assignedToMembershipId` — the lib reuses
 *     `computeAdherenceMetrics`, which already enforces this; the
 *     test seeds rows that exercise the predicate so a future
 *     refactor that conflates the two breaks here.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  evaluateTenantFirmAdherenceAckRate,
  runFirmAdherenceAckMonitor,
  ACK_RATE_THRESHOLD,
  MIN_ESCALATED_FOR_ALERT,
  WINDOW_DAYS,
} from "@/lib/adherence/firm-ack-monitor";
import { isoWeekKey } from "@/lib/notifications/digest";
import { OPT_OUTABLE_KINDS } from "@/lib/notifications/preferences";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

const HOUR = 60 * 60 * 1000;

/**
 * Seed N escalated adherence rows: `ackedCount` acked,
 * `unackedCount` still-unacked. All `escalatedAt` inside `WINDOW_DAYS`.
 *
 * Each row needs a Draft (FK), so we create one per row. Status SENT
 * with `sentMarkedAt` set so the fixture rows would survive any
 * future "SENT-only" filter the lib might add (defensive — today
 * `computeAdherenceMetrics` only filters by `escalatedAt`, but seeded
 * fixtures matching production state are safer than the minimal set).
 */
async function seedEscalatedAdherence(opts: {
  tenantId: string;
  membershipId: string;
  ackedCount: number;
  unackedCount: number;
}) {
  const escalatedAt = new Date(Date.now() - 24 * HOUR);
  async function makeDraft() {
    return superDb.draft.create({
      data: {
        tenantId: opts.tenantId,
        membershipId: opts.membershipId,
        kind: "EMAIL",
        status: "SENT",
        channel: "EMAIL",
        subject: "firm-ack-adh fixture",
        body: "body",
        sentText: "body",
        sentMarkedAt: new Date(),
      },
    });
  }
  for (let i = 0; i < opts.ackedCount; i += 1) {
    const draft = await makeDraft();
    await superDb.communicationAdherence.create({
      data: {
        tenantId: opts.tenantId,
        draftId: draft.id,
        membershipId: opts.membershipId,
        fcgVersionUsed: 1,
        overall: 0.4,
        perDimension: {},
        perRule: [],
        escalatedAt,
        acknowledgedAt: new Date(escalatedAt.getTime() + HOUR),
        acknowledgedById: opts.membershipId,
      },
    });
  }
  for (let i = 0; i < opts.unackedCount; i += 1) {
    const draft = await makeDraft();
    await superDb.communicationAdherence.create({
      data: {
        tenantId: opts.tenantId,
        draftId: draft.id,
        membershipId: opts.membershipId,
        fcgVersionUsed: 1,
        overall: 0.4,
        perDimension: {},
        perRule: [],
        escalatedAt,
      },
    });
  }
}

describe("firm-adherence-ack-monitor — threshold + dedupe", () => {
  it("fires alert + audit when ack rate below threshold and above volume floor", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("adh-admin-low-ack"),
      },
    );

    // 4 acked, 6 unacked → 40% over 10 escalations. Below 75%
    // threshold, above the volume floor of 5.
    await seedEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 4,
      unackedCount: 6,
    });

    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.escalated).toBe(10);
    expect(outcome.acknowledged).toBe(4);
    expect(outcome.acknowledgedRate).toBe(0.4);
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    // Dispatch row exists with the ISO-week dedupeKey under the
    // adherence-side namespace (NOT the item-71 `firm-adherence-below:`
    // slot).
    const week = isoWeekKey(new Date());
    const dispatch = await superDb.notificationDispatch.findUnique({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: admin.id,
          kind: "firm_adherence_ack_rate_below_threshold",
          dedupeKey: `firm-adherence-ack-below:${week}`,
        },
      },
    });
    expect(dispatch).not.toBeNull();

    // Audit row landed on the tenant's chain.
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).not.toBeNull();

    // Second run inside the same week → already_alerted_this_week,
    // no additional dispatch, no additional audit.
    const second = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(second.result).toBe("already_alerted_this_week");
    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audits).toHaveLength(1);
  });

  it("above threshold → no alert, no audit, no dispatch row", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("adh-admin-good"),
      },
    );
    // 8 acked, 2 unacked → 80% — above 75% threshold.
    await seedEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 8,
      unackedCount: 2,
    });

    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("above_threshold");
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).toBeNull();
  });

  it("below threshold but below volume floor → skipped_low_volume", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("adh-admin-thin"),
      },
    );
    // 0 acked, 3 unacked → 0% over 3 escalations. Below volume floor of 5.
    await seedEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 0,
      unackedCount: 3,
    });

    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("skipped_low_volume");
    if (outcome.result !== "skipped_low_volume") throw new Error("unreachable");
    expect(outcome.escalated).toBe(3);
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).toBeNull();
  });

  it("no escalations → no_data short-circuit", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("adh-admin-empty"),
    });

    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("no_data");
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).toBeNull();
  });

  it("only FIRM_ADMIN gets the firm-wide alert (USER / FCT_MEMBER don't)", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("adh-admin-only"),
      },
    );
    const { membership: user } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-user-only"),
    });
    const { membership: fct } = await createTestUserAndMembership(tenant.id, {
      role: "FCT_MEMBER",
      email: uniqueEmail("adh-fct-only"),
    });

    await seedEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 1,
      unackedCount: 7,
    });

    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    const week = isoWeekKey(new Date());
    for (const m of [user, fct]) {
      const dispatch = await superDb.notificationDispatch.findUnique({
        where: {
          membershipId_kind_dedupeKey: {
            membershipId: m.id,
            kind: "firm_adherence_ack_rate_below_threshold",
            dedupeKey: `firm-adherence-ack-below:${week}`,
          },
        },
      });
      expect(dispatch).toBeNull();
    }
  });

  it("cross-tenant isolation: tenant A's bad week doesn't touch tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: adminA } = await createTestUserAndMembership(
      tenantA.id,
      { role: "FIRM_ADMIN", email: uniqueEmail("adh-admin-A") },
    );
    const { membership: adminB } = await createTestUserAndMembership(
      tenantB.id,
      { role: "FIRM_ADMIN", email: uniqueEmail("adh-admin-B") },
    );

    await seedEscalatedAdherence({
      tenantId: tenantA.id,
      membershipId: adminA.id,
      ackedCount: 2,
      unackedCount: 8,
    });
    await seedEscalatedAdherence({
      tenantId: tenantB.id,
      membershipId: adminB.id,
      ackedCount: 8,
      unackedCount: 2,
    });

    const run = await runFirmAdherenceAckMonitor();
    expect(run.alerted).toBeGreaterThanOrEqual(1);
    const outcomes = new Map(
      run.perTenant.map((p) => [p.tenantId, p.outcome.result]),
    );
    expect(outcomes.get(tenantA.id)).toBe("alerted");
    expect(outcomes.get(tenantB.id)).toBe("above_threshold");

    const week = isoWeekKey(new Date());
    const dispatchB = await superDb.notificationDispatch.findUnique({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: adminB.id,
          kind: "firm_adherence_ack_rate_below_threshold",
          dedupeKey: `firm-adherence-ack-below:${week}`,
        },
      },
    });
    expect(dispatchB).toBeNull();
  });

  it("dedupe namespace is DISTINCT from item 71's firm-adherence-below slot", async () => {
    // Load-bearing invariant: items 71 + 95 measure two different
    // questions on the same pillar and MUST fire independently in the
    // same week. The dedupeKey prefix is what keeps them separate.
    // If a future refactor accidentally aliases the namespaces, this
    // test catches it: we seed an item-71 dispatch row with the OLD
    // prefix, then fire the item-95 evaluator, and assert it fires
    // (didn't see the item-71 row as a "already alerted" probe).
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      { role: "FIRM_ADMIN", email: uniqueEmail("adh-dedupe-ns") },
    );
    const week = isoWeekKey(new Date());

    // Pre-seed an item-71-style dispatch row to simulate "this tenant
    // already got the FCG-window adherence alert this week."
    await superDb.notificationDispatch.create({
      data: {
        tenantId: tenant.id,
        membershipId: admin.id,
        kind: "firm_adherence_below_threshold",
        dedupeKey: `firm-adherence-below:${week}`,
        status: "DISPATCHED",
        subject: "preexisting item-71 alert",
        payload: {},
      },
    });

    // Now seed below-threshold adherence-escalation data and run
    // item 95's evaluator. It MUST fire (the item-71 row in the
    // table is for a different kind+dedupeKey and must not be
    // observed as a duplicate).
    await seedEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 2,
      unackedCount: 8,
    });
    const outcome = await evaluateTenantFirmAdherenceAckRate({
      tenantId: tenant.id,
    });
    expect(outcome.result).toBe("alerted");

    // Both dispatch rows now coexist on the same Membership for the
    // same ISO week, distinguished only by kind+dedupeKey prefix.
    const item95Row = await superDb.notificationDispatch.findUnique({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: admin.id,
          kind: "firm_adherence_ack_rate_below_threshold",
          dedupeKey: `firm-adherence-ack-below:${week}`,
        },
      },
    });
    expect(item95Row).not.toBeNull();
  });

  it("notification kind is mandatory (not in OPT_OUTABLE_KINDS)", () => {
    // Defence-in-depth: the dispatcher short-circuits opt-outable kinds
    // when a Membership has a preference row turning them off. This
    // alert MUST always send — the firm's response posture to a
    // compliance escalation IS the governance signal. Mirror of item
    // 84's mandatory-kind assertion.
    expect(
      (OPT_OUTABLE_KINDS as readonly string[]).includes(
        "firm_adherence_ack_rate_below_threshold",
      ),
    ).toBe(false);
  });

  it("constants are exported and stable", () => {
    expect(WINDOW_DAYS).toBe(7);
    expect(ACK_RATE_THRESHOLD).toBe(0.75);
    expect(MIN_ESCALATED_FOR_ALERT).toBe(5);
  });
});
