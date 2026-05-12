/**
 * Post-PRD hardening item 54 — stale-draft sweeper.
 *
 * Coverage:
 *   - Happy path: a Draft with `fcgWindowDeadline` in the past and a
 *     non-terminal status fires one `draft_stale` dispatch + one
 *     DRAFT_STALE_WARNED audit row.
 *   - Idempotent: re-running the sweep produces no new dispatches.
 *   - Skip: deadline still in the future.
 *   - Skip: status SENT (terminal).
 *   - Skip: status DISCARDED (terminal).
 *   - Skip: no fcgWindowDeadline set (substantive drafts with no FCG
 *     window can never be "stale" against a missing promise).
 *   - Skip: owning Membership not ACTIVE.
 *   - Mandatory kind: a poked-in mute preference is ignored — the
 *     dispatcher still writes a real dispatch.
 *   - Status EDITED + ACCEPTED also trigger the warning (only SENT
 *     and DISCARDED are terminal).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { runDraftStaleSweep } from "@/lib/drafts/stale-sweep";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function makeDraft(opts: {
  tenantId: string;
  membershipId: string;
  status?: "PROPOSED" | "EDITED" | "ACCEPTED" | "DISCARDED" | "SENT";
  fcgWindowDeadline?: Date | null;
  subject?: string;
}) {
  return superDb.draft.create({
    data: {
      tenantId: opts.tenantId,
      membershipId: opts.membershipId,
      kind: "HOLDING",
      status: opts.status ?? "PROPOSED",
      channel: "EMAIL",
      subject: opts.subject ?? "Stale subject test",
      body: "Body",
      holdingRequired: true,
      fcgWindowDeadline: opts.fcgWindowDeadline ?? null,
    },
  });
}

describe("draft-stale sweep — happy path + idempotency", () => {
  it("fires one warning + audit for a past-deadline non-terminal draft", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("stale"),
    });
    const draft = await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "PROPOSED",
      fcgWindowDeadline: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.warned).toBe(1);
    expect(r.errored).toBe(0);

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "draft_stale",
        dedupeKey: draft.id,
      },
    });
    expect(dispatch).toBeTruthy();

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "DRAFT_STALE_WARNED",
        subjectId: draft.id,
      },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as {
      draftId: string;
      minutesOverdue: number;
      status: string;
    };
    expect(payload.draftId).toBe(draft.id);
    expect(payload.status).toBe("PROPOSED");
    // 3h overdue → at least 170 minutes (allowing for test wall-clock drift).
    expect(payload.minutesOverdue).toBeGreaterThanOrEqual(170);
  });

  it("is idempotent: second sweep produces no new dispatch", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("idem"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });

    const first = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(first.warned).toBe(1);

    const second = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(second.warned).toBe(0);
    expect(second.alreadyWarned).toBe(1);

    const dispatchCount = await superDb.notificationDispatch.count({
      where: { tenantId: tenant.id, kind: "draft_stale" },
    });
    expect(dispatchCount).toBe(1);
  });

  it("also fires for EDITED and ACCEPTED statuses (not just PROPOSED)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("edited"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "EDITED",
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "ACCEPTED",
      fcgWindowDeadline: new Date(Date.now() - 30 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.warned).toBe(2);
  });
});

describe("draft-stale sweep — skip conditions", () => {
  it("skips drafts with deadline in the future", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("future"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      fcgWindowDeadline: new Date(Date.now() + 60 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips drafts with no fcgWindowDeadline (no FCG promise to break)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("noDeadline"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      fcgWindowDeadline: null,
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
  });

  it("skips SENT drafts (terminal)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("sent"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "SENT",
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips DISCARDED drafts (terminal)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("discarded"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      status: "DISCARDED",
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips drafts owned by a non-ACTIVE Membership", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("leaver"),
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });
    await superDb.membership.update({
      where: { id: membership.id },
      data: { status: "LEAVER_FROZEN", leaverMarkedAt: new Date() },
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.warned).toBe(0);
  });
});

describe("draft-stale sweep — mandatory kind (item 45 interaction)", () => {
  it("ignores a muted preference: dispatch still writes", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("mute"),
    });
    await superDb.membershipNotificationPreference.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "draft_stale",
        emailEnabled: false,
      },
    });
    await makeDraft({
      tenantId: tenant.id,
      membershipId: membership.id,
      fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await runDraftStaleSweep({ tenantId: tenant.id });
    expect(r.warned).toBe(1);

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { tenantId: tenant.id, kind: "draft_stale" },
    });
    expect(dispatch).toBeTruthy();
    expect(dispatch!.status).not.toBe("SKIPPED_USER_PREFERENCE");
  });
});
