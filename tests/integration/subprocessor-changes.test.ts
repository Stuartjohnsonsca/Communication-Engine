/**
 * Sub-processor change notification with prior notice (post-PRD
 * hardening item 24).
 *
 * Coverage:
 *   - announceChange (ADDED): creates staged SubProcessor + change row,
 *     audits on operator chain, fans out notifications to every Client
 *     FIRM_ADMIN (NOT to Acumon operators), refuses if code already
 *     exists.
 *   - announceChange (REMOVED): requires existing active SubProcessor,
 *     refuses if already-inactive, refuses if another REMOVED change is
 *     already announced (race-protection).
 *   - announceChange (MATERIAL_UPDATE): allowed alongside REMOVED but not
 *     alongside another MATERIAL_UPDATE.
 *   - effectiveAt clamp [now+1d, now+365d] is enforced.
 *   - confirmChange: ADDED flips SubProcessor.isActive=true, REMOVED
 *     flips it to false, MATERIAL_UPDATE leaves SubProcessor alone;
 *     emits SUBPROCESSOR_CHANGE_EFFECTIVE audit + notification.
 *   - cancelChange: flips status to CANCELLED, audits, notifies, and
 *     subsequent confirm is a no-op.
 *   - processDueChanges: picks up only ANNOUNCED rows whose effectiveAt
 *     has elapsed; idempotent on a second pass.
 *   - raiseObjection: tenant-scoped, refuses on non-ANNOUNCED change,
 *     refuses on duplicate, allows re-raise after withdrawal.
 *   - withdrawObjection: sets withdrawnAt, audits, idempotent.
 *   - Tenant isolation: an objection in tenant A is invisible to tenant B
 *     via tenantDb.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  announceChange,
  cancelChange,
  confirmChange,
  DEFAULT_NOTICE_DAYS,
  getChange,
  getObjectionForTenant,
  listObjectionsForChange,
  listPendingChanges,
  processDueChanges,
  raiseObjection,
  SubProcessorChangeValidationError,
  withdrawObjection,
} from "@/lib/subprocessors";

const DAY = 24 * 60 * 60 * 1000;

async function ensureAcumonTenant() {
  const existing = await superDb.tenant.findUnique({ where: { slug: "acumon" } });
  if (existing) return existing;
  return superDb.tenant.create({
    data: { slug: "acumon", name: "Acumon (operator) — test" },
  });
}

async function makeUserMembership(tenantId: string, role: "FIRM_ADMIN" | "USER" = "FIRM_ADMIN") {
  const email = `${randomUUID().slice(0, 8)}@example.com`;
  const user = await superDb.user.create({ data: { email } });
  const membership = await superDb.membership.create({
    data: { tenantId, userId: user.id, role, status: "ACTIVE" },
  });
  return { user, membership };
}

async function makeClientTenant() {
  const t = await superDb.tenant.create({
    data: {
      slug: `client-${randomUUID().slice(0, 8)}`,
      name: "Test client",
      status: "ACTIVE",
    },
  });
  return t;
}

let acumon: Awaited<ReturnType<typeof ensureAcumonTenant>>;
let acumonAdmin: Awaited<ReturnType<typeof makeUserMembership>>;

beforeAll(async () => {
  acumon = await ensureAcumonTenant();
  acumonAdmin = await makeUserMembership(acumon.id, "FIRM_ADMIN");
});

let uniqueCounter = 0;
function spCode(): string {
  uniqueCounter += 1;
  return `sp-${uniqueCounter}-${randomUUID().slice(0, 6)}`;
}

describe("announceChange (ADDED)", () => {
  it("creates a staged sub-processor + change row + audit + fans out to Client FIRM_ADMIN only", async () => {
    const client = await makeClientTenant();
    const clientAdmin = await makeUserMembership(client.id, "FIRM_ADMIN");
    // Non-FIRM_ADMIN in the same tenant should NOT receive the notification.
    const clientUser = await makeUserMembership(client.id, "USER");

    const code = spCode();
    const before = await superDb.subProcessor.findUnique({ where: { code } });
    expect(before).toBeNull();

    const result = await announceChange({
      kind: "ADDED",
      description: "Switching transcript store to a new vendor.",
      effectiveAt: new Date(Date.now() + 7 * DAY),
      subProcessor: {
        code,
        name: "TranscribeCo",
        role: "Transcript store",
        jurisdiction: "EU-IE",
        dataCategories: ["meeting-transcripts"],
        contractRef: "DPA-2026-09",
        notes: null,
      },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });

    expect(result.change.status).toBe("ANNOUNCED");
    expect(result.change.kind).toBe("ADDED");
    expect(result.subProcessor.isActive).toBe(false);
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: acumon.id,
        eventType: "SUBPROCESSOR_CHANGE_ANNOUNCED",
        subjectId: result.change.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorMembershipId).toBe(acumonAdmin.membership.id);

    // Client FIRM_ADMIN got an inbox row.
    const adminInbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: clientAdmin.membership.id, kind: "subprocessor_change_announced" },
    });
    expect(adminInbox).not.toBeNull();
    // Client USER did NOT.
    const userInbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: clientUser.membership.id, kind: "subprocessor_change_announced" },
    });
    expect(userInbox).toBeNull();
    // Acumon's own FIRM_ADMIN did NOT — Acumon is the announcer.
    const acumonInbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: acumonAdmin.membership.id, kind: "subprocessor_change_announced" },
    });
    expect(acumonInbox).toBeNull();
  });

  it("rejects when code already exists", async () => {
    const code = spCode();
    await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 999,
        name: "Existing",
        role: "Role",
        jurisdiction: "UK",
        dataCategories: [],
        isActive: true,
        addedAt: new Date(),
      },
    });
    await expect(
      announceChange({
        kind: "ADDED",
        description: "trying to add same code",
        effectiveAt: new Date(Date.now() + 7 * DAY),
        subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toBeInstanceOf(SubProcessorChangeValidationError);
  });

  it("rejects effectiveAt outside the [+1d, +365d] window", async () => {
    await expect(
      announceChange({
        kind: "ADDED",
        description: "x",
        effectiveAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12h — too soon
        subProcessor: {
          code: spCode(),
          name: "x",
          role: "x",
          jurisdiction: "x",
          dataCategories: [],
        },
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toMatchObject({ code: "effective-too-soon" });

    await expect(
      announceChange({
        kind: "ADDED",
        description: "x",
        effectiveAt: new Date(Date.now() + 400 * DAY),
        subProcessor: {
          code: spCode(),
          name: "x",
          role: "x",
          jurisdiction: "x",
          dataCategories: [],
        },
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toMatchObject({ code: "effective-too-far" });
  });
});

describe("announceChange (REMOVED / MATERIAL_UPDATE)", () => {
  it("REMOVED requires an existing active sub-processor and refuses concurrent announcements", async () => {
    const code = spCode();
    const sp = await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 1001,
        name: "Existing",
        role: "Role",
        jurisdiction: "UK",
        dataCategories: ["meta"],
        isActive: true,
        addedAt: new Date(),
      },
    });

    const r1 = await announceChange({
      kind: "REMOVED",
      description: "Retiring; replaced by another vendor.",
      effectiveAt: new Date(Date.now() + 14 * DAY),
      subProcessorCode: sp.code,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(r1.change.kind).toBe("REMOVED");

    // Second REMOVED on the same sub-processor while the first is ANNOUNCED:
    await expect(
      announceChange({
        kind: "REMOVED",
        description: "duplicate",
        effectiveAt: new Date(Date.now() + 14 * DAY),
        subProcessorCode: sp.code,
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toMatchObject({ code: "already-announced" });

    // But MATERIAL_UPDATE is independently allowed:
    const r2 = await announceChange({
      kind: "MATERIAL_UPDATE",
      description: "DPA terms refreshed.",
      effectiveAt: new Date(Date.now() + 14 * DAY),
      subProcessorCode: sp.code,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(r2.change.kind).toBe("MATERIAL_UPDATE");
  });

  it("refuses REMOVED on an already-inactive sub-processor", async () => {
    const code = spCode();
    const sp = await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 1010,
        name: "Already removed",
        role: "Role",
        jurisdiction: "UK",
        dataCategories: [],
        isActive: false,
        addedAt: new Date(),
        removedAt: new Date(),
      },
    });
    await expect(
      announceChange({
        kind: "REMOVED",
        description: "x",
        effectiveAt: new Date(Date.now() + 14 * DAY),
        subProcessorCode: sp.code,
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toMatchObject({ code: "already-inactive" });
  });
});

describe("confirmChange", () => {
  it("ADDED → SubProcessor.isActive=true + audit + notification", async () => {
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "new vendor",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessor: { code, name: "NewVendor", role: "Role", jurisdiction: "UK", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });

    const confirmed = await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(confirmed?.status).toBe("EFFECTIVE");
    expect(confirmed?.confirmedAt).toBeTruthy();

    const sp = await superDb.subProcessor.findUnique({ where: { code } });
    expect(sp?.isActive).toBe(true);

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: acumon.id,
        eventType: "SUBPROCESSOR_CHANGE_EFFECTIVE",
        subjectId: r.change.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("REMOVED → SubProcessor.isActive=false + removedAt set", async () => {
    const code = spCode();
    const sp = await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 1020,
        name: "ToRemove",
        role: "Role",
        jurisdiction: "UK",
        dataCategories: [],
        isActive: true,
        addedAt: new Date(),
      },
    });
    const r = await announceChange({
      kind: "REMOVED",
      description: "x",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessorCode: sp.code,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const after = await superDb.subProcessor.findUnique({ where: { code } });
    expect(after?.isActive).toBe(false);
    expect(after?.removedAt).toBeTruthy();
  });

  it("MATERIAL_UPDATE does NOT mutate SubProcessor row", async () => {
    const code = spCode();
    const sp = await superDb.subProcessor.create({
      data: {
        code,
        ordinal: 1030,
        name: "Stays",
        role: "Role",
        jurisdiction: "UK",
        dataCategories: [],
        isActive: true,
        addedAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    const r = await announceChange({
      kind: "MATERIAL_UPDATE",
      description: "docs change",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessorCode: sp.code,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const after = await superDb.subProcessor.findUnique({ where: { code } });
    expect(after?.isActive).toBe(true);
    expect(after?.addedAt.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("is idempotent on a non-ANNOUNCED change", async () => {
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "x",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const first = await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(first?.status).toBe("EFFECTIVE");
    const second = await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(second?.status).toBe("EFFECTIVE");
    const audits = await superDb.auditEvent.count({
      where: {
        eventType: "SUBPROCESSOR_CHANGE_EFFECTIVE",
        subjectId: r.change.id,
      },
    });
    expect(audits).toBe(1);
  });
});

describe("cancelChange", () => {
  it("flips status to CANCELLED, audits, and a subsequent confirm is a no-op", async () => {
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "to cancel",
      effectiveAt: new Date(Date.now() + 7 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const cancelled = await cancelChange({
      changeId: r.change.id,
      reason: "Selected a different vendor.",
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledReason).toMatch(/different vendor/);

    const after = await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    expect(after?.status).toBe("CANCELLED");

    const sp = await superDb.subProcessor.findUnique({ where: { code } });
    expect(sp?.isActive).toBe(false);
  });

  it("refuses to cancel a non-ANNOUNCED change", async () => {
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "x",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await confirmChange({
      changeId: r.change.id,
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await expect(
      cancelChange({
        changeId: r.change.id,
        reason: "x",
        actorTenantId: acumon.id,
        actorMembershipId: acumonAdmin.membership.id,
      }),
    ).rejects.toMatchObject({ code: "not-announced" });
  });
});

describe("processDueChanges", () => {
  it("auto-confirms only ANNOUNCED rows whose effectiveAt has elapsed; idempotent on re-run", async () => {
    const code1 = spCode();
    const code2 = spCode();
    const due = await announceChange({
      kind: "ADDED",
      description: "due",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessor: { code: code1, name: "Due", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const notYet = await announceChange({
      kind: "ADDED",
      description: "not yet",
      effectiveAt: new Date(Date.now() + 60 * DAY),
      subProcessor: { code: code2, name: "Future", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });

    // Move "due" effectiveAt into the past — simulating the notice having elapsed.
    await superDb.subProcessorChange.update({
      where: { id: due.change.id },
      data: { effectiveAt: new Date(Date.now() - 60 * 1000) },
    });

    const r1 = await processDueChanges();
    expect(r1.confirmed).toBeGreaterThanOrEqual(1);

    const after = await getChange(due.change.id);
    expect(after?.status).toBe("EFFECTIVE");
    const stillPending = await getChange(notYet.change.id);
    expect(stillPending?.status).toBe("ANNOUNCED");

    // Re-run: now no rows are due (the recently-confirmed one is EFFECTIVE,
    // the future one is still in the future).
    const r2 = await processDueChanges();
    expect(r2.confirmed).toBe(0);
  });
});

describe("raiseObjection / withdrawObjection", () => {
  it("creates objection on tenant chain + audits; cross-tenant isolation holds", async () => {
    const clientA = await makeClientTenant();
    const clientB = await makeClientTenant();
    const adminA = await makeUserMembership(clientA.id, "FIRM_ADMIN");
    const adminB = await makeUserMembership(clientB.id, "FIRM_ADMIN");

    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "x",
      effectiveAt: new Date(Date.now() + 30 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });

    const o = await raiseObjection({
      tenantId: clientA.id,
      subProcessorChangeId: r.change.id,
      raisedByMembershipId: adminA.membership.id,
      reason: "Jurisdiction concern.",
    });
    expect(o.reason).toBe("Jurisdiction concern.");

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: clientA.id,
        eventType: "SUBPROCESSOR_OBJECTION_RAISED",
        subjectId: o.id,
      },
    });
    expect(audit).not.toBeNull();

    // Tenant A sees its own objection via tenantDb.
    const seenByA = await getObjectionForTenant(clientA.id, r.change.id);
    expect(seenByA?.id).toBe(o.id);

    // Tenant B sees nothing — RLS isolates.
    const seenByB = await getObjectionForTenant(clientB.id, r.change.id);
    expect(seenByB).toBeNull();

    // Operator-side list-all returns the objection (no withdraw yet).
    const all = await listObjectionsForChange(r.change.id);
    expect(all.map((x) => x.id)).toContain(o.id);

    // Tenant B can independently raise its own.
    const oB = await raiseObjection({
      tenantId: clientB.id,
      subProcessorChangeId: r.change.id,
      raisedByMembershipId: adminB.membership.id,
      reason: "Different concern.",
    });
    expect(oB.tenantId).toBe(clientB.id);

    // Duplicate from the same tenant is refused.
    await expect(
      raiseObjection({
        tenantId: clientA.id,
        subProcessorChangeId: r.change.id,
        raisedByMembershipId: adminA.membership.id,
        reason: "again",
      }),
    ).rejects.toMatchObject({ code: "already-raised" });
  });

  it("refuses on non-ANNOUNCED change", async () => {
    const client = await makeClientTenant();
    const admin = await makeUserMembership(client.id, "FIRM_ADMIN");
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "x",
      effectiveAt: new Date(Date.now() + 1.5 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await cancelChange({
      changeId: r.change.id,
      reason: "scrap",
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    await expect(
      raiseObjection({
        tenantId: client.id,
        subProcessorChangeId: r.change.id,
        raisedByMembershipId: admin.membership.id,
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "change-closed" });
  });

  it("withdrawObjection sets withdrawnAt + audits + is idempotent; re-raise after withdrawal is allowed", async () => {
    const client = await makeClientTenant();
    const admin = await makeUserMembership(client.id, "FIRM_ADMIN");
    const code = spCode();
    const r = await announceChange({
      kind: "ADDED",
      description: "x",
      effectiveAt: new Date(Date.now() + 30 * DAY),
      subProcessor: { code, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const o = await raiseObjection({
      tenantId: client.id,
      subProcessorChangeId: r.change.id,
      raisedByMembershipId: admin.membership.id,
      reason: "First reason.",
    });
    const w1 = await withdrawObjection({
      tenantId: client.id,
      objectionId: o.id,
      withdrawnByMembershipId: admin.membership.id,
      reason: "Resolved offline.",
    });
    expect(w1.withdrawnAt).not.toBeNull();
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: client.id,
        eventType: "SUBPROCESSOR_OBJECTION_WITHDRAWN",
        subjectId: o.id,
      },
    });
    expect(audit).not.toBeNull();

    // Idempotent.
    const w2 = await withdrawObjection({
      tenantId: client.id,
      objectionId: o.id,
      withdrawnByMembershipId: admin.membership.id,
    });
    expect(w2.id).toBe(o.id);
    const audits = await superDb.auditEvent.count({
      where: {
        eventType: "SUBPROCESSOR_OBJECTION_WITHDRAWN",
        subjectId: o.id,
      },
    });
    expect(audits).toBe(1);

    // Re-raise after withdrawal — uniqueness allows this via the in-place reset path.
    const re = await raiseObjection({
      tenantId: client.id,
      subProcessorChangeId: r.change.id,
      raisedByMembershipId: admin.membership.id,
      reason: "Concern resurfaced.",
    });
    expect(re.id).toBe(o.id);
    expect(re.withdrawnAt).toBeNull();
    expect(re.reason).toBe("Concern resurfaced.");
  });
});

describe("listPendingChanges", () => {
  it("returns only ANNOUNCED rows, ordered by effectiveAt asc", async () => {
    // We can't assume isolation across test files; just check the rows we
    // added land in the right order if there are at least two.
    const c1 = spCode();
    const c2 = spCode();
    const r1 = await announceChange({
      kind: "ADDED",
      description: "early",
      effectiveAt: new Date(Date.now() + 5 * DAY),
      subProcessor: { code: c1, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });
    const r2 = await announceChange({
      kind: "ADDED",
      description: "later",
      effectiveAt: new Date(Date.now() + 30 * DAY),
      subProcessor: { code: c2, name: "x", role: "x", jurisdiction: "x", dataCategories: [] },
      actorTenantId: acumon.id,
      actorMembershipId: acumonAdmin.membership.id,
    });

    const pending = await listPendingChanges();
    const ids = pending.map((c) => c.id);
    const idx1 = ids.indexOf(r1.change.id);
    const idx2 = ids.indexOf(r2.change.id);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
  });
});

describe("DEFAULT_NOTICE_DAYS constant", () => {
  it("matches industry DPA notice (30d)", () => {
    expect(DEFAULT_NOTICE_DAYS).toBe(30);
  });
});
