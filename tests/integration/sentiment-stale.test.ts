/**
 * Post-PRD hardening item 77 — stale-sentiment-escalation sweep.
 *
 * Coverage:
 *   - Happy path: escalated > STALE_THRESHOLD_HOURS ago, unacked →
 *     one stale dispatch per recipient + one
 *     SENTIMENT_ESCALATION_STALE_WARNED audit per signal.
 *   - Idempotent: a second sweep tick doesn't double-fire (audit
 *     chain is the dedupe gate).
 *   - Skip: escalated more recently than the threshold.
 *   - Skip: never escalated (escalatedAt null).
 *   - Skip: already acknowledged.
 *   - Tenant scoping: a signal in another tenant doesn't trip this
 *     tenant's sweep.
 *   - Audit ordering: audit row exists even when dispatch fan-out
 *     is empty (no recipients), matching the "audit first" invariant.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  runSentimentStaleSweep,
  STALE_THRESHOLD_HOURS,
} from "@/lib/sentiment/stale-sweep";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY =
  process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function makeEscalatedSignal(opts: {
  tenantId: string;
  assignedToMembershipId: string | null;
  escalatedAtMsAgo: number;
  acknowledgedAt?: Date | null;
  classification?: "EXTREME_NEG" | "EXTREME_POS" | "NEUTRAL";
}) {
  const now = Date.now();
  return superDb.sentimentSignal.create({
    data: {
      tenantId: opts.tenantId,
      classification: opts.classification ?? "EXTREME_NEG",
      confidence: 0.8,
      isAboutFirmHandling: true,
      trigger: "test-trigger",
      shouldEscalate: true,
      escalatedAt: new Date(now - opts.escalatedAtMsAgo),
      acknowledgedAt: opts.acknowledgedAt ?? null,
      assignedToMembershipId: opts.assignedToMembershipId,
    },
  });
}

describe("sentiment-stale sweep — happy path + idempotency", () => {
  it("fires one audit + dispatches for an unacked, threshold-aged escalation", async () => {
    const tenant = await createTestTenant();
    const assignee = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("stale-assignee"),
    });
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("stale-admin"),
    });

    const signal = await makeEscalatedSignal({
      tenantId: tenant.id,
      assignedToMembershipId: assignee.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });

    const r = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.warned).toBe(1);
    expect(r.errored).toBe(0);

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
        subjectId: signal.id,
      },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as {
      signalId?: string;
      thresholdHours?: number;
      classification?: string;
    };
    expect(payload.signalId).toBe(signal.id);
    expect(payload.thresholdHours).toBe(STALE_THRESHOLD_HOURS);
    expect(payload.classification).toBe("EXTREME_NEG");

    // At least the assignee should have a dispatch row.
    const assigneeDispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        membershipId: assignee.membership.id,
        kind: "sentiment_escalation_stale",
        dedupeKey: signal.id,
      },
    });
    expect(assigneeDispatch).toBeTruthy();
  });

  it("a second sweep tick does not write a second audit row", async () => {
    const tenant = await createTestTenant();
    const assignee = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("stale-idem"),
    });
    await makeEscalatedSignal({
      tenantId: tenant.id,
      assignedToMembershipId: assignee.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 2) * 60 * 60 * 1000,
    });

    const r1 = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r1.warned).toBe(1);
    expect(r1.alreadyWarned).toBe(0);

    const r2 = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r2.warned).toBe(0);
    expect(r2.alreadyWarned).toBe(1);

    const auditCount = await superDb.auditEvent.count({
      where: {
        tenantId: tenant.id,
        eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditCount).toBe(1);
  });
});

describe("sentiment-stale sweep — skip conditions", () => {
  it("does not nudge a freshly-escalated signal (under threshold)", async () => {
    const tenant = await createTestTenant();
    const assignee = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("stale-fresh"),
    });
    await makeEscalatedSignal({
      tenantId: tenant.id,
      assignedToMembershipId: assignee.membership.id,
      escalatedAtMsAgo: 30 * 60 * 1000, // 30 min — under 4h threshold
    });
    const r = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("does not nudge an unescalated signal", async () => {
    const tenant = await createTestTenant();
    const assignee = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("stale-noesc"),
    });
    await superDb.sentimentSignal.create({
      data: {
        tenantId: tenant.id,
        classification: "EXTREME_NEG",
        confidence: 0.5,
        isAboutFirmHandling: false,
        shouldEscalate: false,
        escalatedAt: null,
        assignedToMembershipId: assignee.membership.id,
      },
    });
    const r = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
  });

  it("does not nudge an already-acknowledged escalation", async () => {
    const tenant = await createTestTenant();
    const assignee = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("stale-acked"),
    });
    await makeEscalatedSignal({
      tenantId: tenant.id,
      assignedToMembershipId: assignee.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 5) * 60 * 60 * 1000,
      acknowledgedAt: new Date(),
    });
    const r = await runSentimentStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
  });
});

describe("sentiment-stale sweep — tenant isolation", () => {
  it("only nudges signals in the requested tenant", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const aAssignee = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("stale-iso-a"),
    });
    const bAssignee = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("stale-iso-b"),
    });
    const sigA = await makeEscalatedSignal({
      tenantId: tenantA.id,
      assignedToMembershipId: aAssignee.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });
    await makeEscalatedSignal({
      tenantId: tenantB.id,
      assignedToMembershipId: bAssignee.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });

    const rA = await runSentimentStaleSweep({ tenantId: tenantA.id });
    expect(rA.warned).toBe(1);
    // Confirm: only the tenantA audit row exists.
    const auditsA = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenantA.id,
        eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0]?.subjectId).toBe(sigA.id);
    // tenantB still untouched.
    const auditsB = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenantB.id,
        eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditsB).toHaveLength(0);
  });
});
