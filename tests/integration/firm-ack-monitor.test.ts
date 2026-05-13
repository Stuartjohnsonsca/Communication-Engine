/**
 * Post-PRD hardening item 84 — firm-wide sentiment ack-rate
 * escalation cron.
 *
 * Coverage:
 *   - below threshold + above volume floor → notification + audit fire,
 *     deduped per ISO week so a second cron run is a no-op.
 *   - above threshold → no notification, no audit, no dispatch row.
 *   - below threshold but below volume floor → no notification (floor
 *     stops fresh tenants with 1-4 escalations from tripping the alert).
 *   - no escalations → no_data short-circuit (never trips).
 *   - cross-tenant isolation: tenant A's bad week doesn't touch tenant B.
 *   - FIRM_ADMIN-only recipient list: USER and FCT_MEMBER memberships
 *     don't receive the firm-wide alert.
 *   - Notification kind is mandatory: present in NotificationKind union
 *     but NOT in OPT_OUTABLE_KINDS, so even a stale preference row
 *     can't mute it.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  evaluateTenantFirmAckRate,
  runFirmAckMonitor,
  ACK_RATE_THRESHOLD,
  MIN_ESCALATED_FOR_ALERT,
  WINDOW_DAYS,
} from "@/lib/sentiment/firm-ack-monitor";
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
 * Seed N escalated signals: `ackedCount` acked, `unackedCount`
 * still-unacked. All `escalatedAt` inside `WINDOW_DAYS`.
 */
async function seedEscalatedSignals(opts: {
  tenantId: string;
  membershipId: string;
  ackedCount: number;
  unackedCount: number;
}) {
  const escalatedAt = new Date(Date.now() - 24 * HOUR);
  for (let i = 0; i < opts.ackedCount; i += 1) {
    await superDb.sentimentSignal.create({
      data: {
        tenantId: opts.tenantId,
        classification: "EXTREME_NEG",
        confidence: 0.9,
        isAboutFirmHandling: true,
        shouldEscalate: true,
        escalatedAt,
        acknowledgedAt: new Date(escalatedAt.getTime() + HOUR),
        acknowledgedById: opts.membershipId,
        assignedToMembershipId: opts.membershipId,
      },
    });
  }
  for (let i = 0; i < opts.unackedCount; i += 1) {
    await superDb.sentimentSignal.create({
      data: {
        tenantId: opts.tenantId,
        classification: "EXTREME_NEG",
        confidence: 0.9,
        isAboutFirmHandling: true,
        shouldEscalate: true,
        escalatedAt,
        assignedToMembershipId: opts.membershipId,
      },
    });
  }
}

describe("firm-ack-monitor — threshold + dedupe", () => {
  it("fires alert + audit when ack rate below threshold and above volume floor", async () => {
    const tenant = await createTestTenant();
    const { membership: admin } = await createTestUserAndMembership(
      tenant.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("admin-low-ack"),
      },
    );

    // 4 acked, 6 unacked → 40% over 10 signals. Below 75% threshold,
    // above the volume floor of 5.
    await seedEscalatedSignals({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 4,
      unackedCount: 6,
    });

    const outcome = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.escalated).toBe(10);
    expect(outcome.acknowledged).toBe(4);
    expect(outcome.acknowledgedRate).toBe(0.4);
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    // Dispatch row exists with the ISO-week dedupeKey.
    const week = isoWeekKey(new Date());
    const dispatch = await superDb.notificationDispatch.findUnique({
      where: {
        membershipId_kind_dedupeKey: {
          membershipId: admin.id,
          kind: "firm_sentiment_ack_rate_below_threshold",
          dedupeKey: `firm-sentiment-ack-below:${week}`,
        },
      },
    });
    expect(dispatch).not.toBeNull();

    // Audit row landed on the tenant's chain.
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).not.toBeNull();

    // Second run inside the same week → already_alerted_this_week, no
    // additional dispatch, no additional audit.
    const second = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(second.result).toBe("already_alerted_this_week");
    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
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
        email: uniqueEmail("admin-good"),
      },
    );
    // 8 acked, 2 unacked → 80% over 10 signals — above 75% threshold.
    await seedEscalatedSignals({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 8,
      unackedCount: 2,
    });

    const outcome = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(outcome.result).toBe("above_threshold");
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
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
        email: uniqueEmail("admin-thin"),
      },
    );
    // 0 acked, 3 unacked → 0% over 3 signals. Below volume floor of 5.
    await seedEscalatedSignals({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 0,
      unackedCount: 3,
    });

    const outcome = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(outcome.result).toBe("skipped_low_volume");
    if (outcome.result !== "skipped_low_volume") throw new Error("unreachable");
    expect(outcome.escalated).toBe(3);
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
      },
    });
    expect(audit).toBeNull();
  });

  it("no escalations → no_data short-circuit", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin-empty"),
    });

    const outcome = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(outcome.result).toBe("no_data");
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
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
        email: uniqueEmail("admin-only"),
      },
    );
    const { membership: user } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("user-only"),
    });
    const { membership: fct } = await createTestUserAndMembership(tenant.id, {
      role: "FCT_MEMBER",
      email: uniqueEmail("fct-only"),
    });

    await seedEscalatedSignals({
      tenantId: tenant.id,
      membershipId: admin.id,
      ackedCount: 1,
      unackedCount: 7,
    });

    const outcome = await evaluateTenantFirmAckRate({ tenantId: tenant.id });
    expect(outcome.result).toBe("alerted");
    if (outcome.result !== "alerted") throw new Error("unreachable");
    expect(outcome.notifiedMembershipIds).toEqual([admin.id]);

    const week = isoWeekKey(new Date());
    for (const m of [user, fct]) {
      const dispatch = await superDb.notificationDispatch.findUnique({
        where: {
          membershipId_kind_dedupeKey: {
            membershipId: m.id,
            kind: "firm_sentiment_ack_rate_below_threshold",
            dedupeKey: `firm-sentiment-ack-below:${week}`,
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
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("admin-A"),
      },
    );
    const { membership: adminB } = await createTestUserAndMembership(
      tenantB.id,
      {
        role: "FIRM_ADMIN",
        email: uniqueEmail("admin-B"),
      },
    );

    // A: 2 acked, 8 unacked = 20% (below threshold, above floor) → alert.
    // B: 8 acked, 2 unacked = 80% → no alert.
    await seedEscalatedSignals({
      tenantId: tenantA.id,
      membershipId: adminA.id,
      ackedCount: 2,
      unackedCount: 8,
    });
    await seedEscalatedSignals({
      tenantId: tenantB.id,
      membershipId: adminB.id,
      ackedCount: 8,
      unackedCount: 2,
    });

    const run = await runFirmAckMonitor();
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
          kind: "firm_sentiment_ack_rate_below_threshold",
          dedupeKey: `firm-sentiment-ack-below:${week}`,
        },
      },
    });
    expect(dispatchB).toBeNull();
  });

  it("notification kind is mandatory (not in OPT_OUTABLE_KINDS)", () => {
    // Defence-in-depth: the dispatcher short-circuits opt-outable kinds
    // when a Membership has a preference row turning them off. This
    // alert MUST always send — the firm's response posture is the
    // governance signal — so the kind is mandatory by being absent
    // from the opt-outable list.
    expect(
      (OPT_OUTABLE_KINDS as readonly string[]).includes(
        "firm_sentiment_ack_rate_below_threshold",
      ),
    ).toBe(false);
  });

  it("constants are exported and stable", () => {
    // Pin the threshold + volume floor so a future change is a
    // deliberate edit + test update, not an accidental drift.
    expect(WINDOW_DAYS).toBe(7);
    expect(ACK_RATE_THRESHOLD).toBe(0.75);
    expect(MIN_ESCALATED_FOR_ALERT).toBe(5);
  });
});
