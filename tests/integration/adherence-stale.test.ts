/**
 * Post-PRD hardening item 99 — stale-adherence-escalation sweep.
 *
 * Adherence-pillar analog of item 77's `sentiment-stale.test.ts`.
 *
 * Coverage:
 *   - Happy path: escalated > STALE_THRESHOLD_HOURS ago, unacked →
 *     one stale dispatch per recipient + one
 *     ADHERENCE_ESCALATION_STALE_WARNED audit per row.
 *   - Idempotent: a second sweep tick doesn't double-fire (audit
 *     chain is the dedupe gate).
 *   - Skip: escalated more recently than the threshold.
 *   - Skip: never escalated (escalatedAt null).
 *   - Skip: already acknowledged.
 *   - Tenant scoping: a row in another tenant doesn't trip this
 *     tenant's sweep.
 *   - Notification kind is mandatory (not in OPT_OUTABLE_KINDS) — a
 *     muted preference row is silently ignored by the dispatcher.
 *   - Distinct dedupe namespace from item 1's `adherence_escalation`:
 *     pre-seeding the original-escalation dispatch row must NOT
 *     suppress the stale nudge dispatch (different `kind`).
 *   - `membershipId` (sender) is the self-recipient — pillar-wide
 *     invariant from item 94's badge predicate.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  runAdherenceStaleSweep,
  STALE_THRESHOLD_HOURS,
} from "@/lib/adherence/stale-sweep";
import { OPT_OUTABLE_KINDS } from "@/lib/notifications/preferences";
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

async function makeEscalatedAdherence(opts: {
  tenantId: string;
  membershipId: string;
  escalatedAtMsAgo: number | null;
  acknowledgedAt?: Date | null;
  overall?: number;
}) {
  const draft = await superDb.draft.create({
    data: {
      tenantId: opts.tenantId,
      membershipId: opts.membershipId,
      kind: "EMAIL",
      status: "SENT",
      channel: "EMAIL",
      subject: "stale-adh fixture",
      body: "body",
      sentText: "body",
      sentMarkedAt: new Date(),
    },
  });
  const now = Date.now();
  return superDb.communicationAdherence.create({
    data: {
      tenantId: opts.tenantId,
      draftId: draft.id,
      membershipId: opts.membershipId,
      fcgVersionUsed: 1,
      overall: opts.overall ?? 0.4,
      perDimension: {},
      perRule: [],
      escalatedAt:
        opts.escalatedAtMsAgo === null
          ? null
          : new Date(now - opts.escalatedAtMsAgo),
      acknowledgedAt: opts.acknowledgedAt ?? null,
    },
  });
}

describe("adherence-stale sweep — happy path + idempotency", () => {
  it("fires one audit + dispatches for an unacked, threshold-aged escalation", async () => {
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-sender"),
    });
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("adh-stale-admin"),
    });

    const adherence = await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });

    const r = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.warned).toBe(1);
    expect(r.errored).toBe(0);

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
        subjectId: adherence.id,
      },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as {
      adherenceId?: string;
      draftId?: string;
      membershipId?: string;
      thresholdHours?: number;
      overall?: number;
    };
    expect(payload.adherenceId).toBe(adherence.id);
    expect(payload.draftId).toBe(adherence.draftId);
    expect(payload.membershipId).toBe(sender.membership.id);
    expect(payload.thresholdHours).toBe(STALE_THRESHOLD_HOURS);
    expect(payload.overall).toBe(0.4);

    // Sender membership (the self-recipient — adherence escalates the
    // SENDER, not an assignee) must have a dispatch row.
    const senderDispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        membershipId: sender.membership.id,
        kind: "adherence_escalation_stale",
        dedupeKey: adherence.id,
      },
    });
    expect(senderDispatch).toBeTruthy();
  });

  it("a second sweep tick does not write a second audit row", async () => {
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-idem"),
    });
    await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 2) * 60 * 60 * 1000,
    });

    const r1 = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r1.warned).toBe(1);
    expect(r1.alreadyWarned).toBe(0);

    const r2 = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r2.warned).toBe(0);
    expect(r2.alreadyWarned).toBe(1);

    const auditCount = await superDb.auditEvent.count({
      where: {
        tenantId: tenant.id,
        eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditCount).toBe(1);
  });
});

describe("adherence-stale sweep — skip conditions", () => {
  it("does not nudge a freshly-escalated row (under threshold)", async () => {
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-fresh"),
    });
    await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: 30 * 60 * 1000, // 30 min — under 4h threshold
    });
    const r = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("does not nudge an unescalated row", async () => {
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-noesc"),
    });
    await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: null,
      overall: 0.9,
    });
    const r = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
  });

  it("does not nudge an already-acknowledged escalation", async () => {
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-acked"),
    });
    await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 5) * 60 * 60 * 1000,
      acknowledgedAt: new Date(),
    });
    const r = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
  });
});

describe("adherence-stale sweep — tenant isolation", () => {
  it("only nudges rows in the requested tenant", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const aSender = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-iso-a"),
    });
    const bSender = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-iso-b"),
    });
    const adhA = await makeEscalatedAdherence({
      tenantId: tenantA.id,
      membershipId: aSender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });
    await makeEscalatedAdherence({
      tenantId: tenantB.id,
      membershipId: bSender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000,
    });

    const rA = await runAdherenceStaleSweep({ tenantId: tenantA.id });
    expect(rA.warned).toBe(1);
    const auditsA = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenantA.id,
        eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0]?.subjectId).toBe(adhA.id);
    const auditsB = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenantB.id,
        eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
      },
    });
    expect(auditsB).toHaveLength(0);
  });
});

describe("adherence-stale sweep — mandatory kind + dedupe namespace", () => {
  it("notification kind is mandatory (not in OPT_OUTABLE_KINDS)", () => {
    expect(
      (OPT_OUTABLE_KINDS as readonly string[]).includes(
        "adherence_escalation_stale",
      ),
    ).toBe(false);
  });

  it("does NOT collide with item-1 adherence_escalation dedupe slot", async () => {
    // The original `adherence_escalation` (item 1) and this stale nudge
    // both use `adherenceId` as `dedupeKey`. NotificationDispatch
    // uniqueness is (membershipId, kind, dedupeKey) — pre-seeding the
    // original kind's dispatch row must NOT suppress the stale nudge,
    // because they're distinct kinds.
    const tenant = await createTestTenant();
    const sender = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-stale-distinct-kinds"),
    });
    const adherence = await makeEscalatedAdherence({
      tenantId: tenant.id,
      membershipId: sender.membership.id,
      escalatedAtMsAgo: (STALE_THRESHOLD_HOURS + 3) * 60 * 60 * 1000,
    });

    // Pre-seed the original-escalation dispatch row (kind:
    // adherence_escalation, dedupeKey == adherenceId).
    await superDb.notificationDispatch.create({
      data: {
        tenantId: tenant.id,
        membershipId: sender.membership.id,
        kind: "adherence_escalation",
        dedupeKey: adherence.id,
        subject: "Original escalation",
        status: "DISPATCHED",
        payload: {},
      },
    });

    const r = await runAdherenceStaleSweep({ tenantId: tenant.id });
    expect(r.warned).toBe(1);

    // Stale nudge dispatch row exists alongside the original.
    const dispatches = await superDb.notificationDispatch.findMany({
      where: {
        tenantId: tenant.id,
        membershipId: sender.membership.id,
        dedupeKey: adherence.id,
      },
      select: { kind: true },
    });
    const kinds = dispatches.map((d) => d.kind).sort();
    expect(kinds).toContain("adherence_escalation");
    expect(kinds).toContain("adherence_escalation_stale");
  });
});
