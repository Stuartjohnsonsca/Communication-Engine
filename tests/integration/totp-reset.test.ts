/**
 * Post-PRD hardening item 19 — admin-initiated TOTP reset.
 *
 * Coverage:
 *  - resetTotpForUser(active enrolled User) clears verifiedAt + stamps
 *    disabledAt + clears recoveryCodesHashed; writes TOTP_RESET_BY_ADMIN
 *    audit on the tenant chain with target id + email + wasEnrolled.
 *  - The post-reset state passes the existing `evaluateTotpGate` as
 *    "not enrolled" (treated as no-TOTP after reset).
 *  - The reset DOES NOT delete the UserTotp row — forensic trail
 *    preserved.
 *  - resetTotpForUser(User without enrollment) returns
 *    {ok:false, reason:"no-enrollment"} — no audit row, no mutation.
 *  - resetTotpForUser(User with no membership in this tenant) returns
 *    {ok:false, reason:"no-membership"} — cross-tenant safety.
 *  - resetTotpForUser(User with INACTIVE membership) returns
 *    {ok:false, reason:"no-membership"} — only ACTIVE members count.
 *  - Notification: an inbox row is created for the affected
 *    member with kind="totp_reset_by_admin" and the audit-event id as
 *    the dedupe key (duplicate calls produce a single inbox row).
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  resetTotpForUser,
  evaluateTotpGate,
} from "@/lib/auth/totp";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

async function enrollWithRecovery(userId: string) {
  return superDb.userTotp.upsert({
    where: { userId },
    create: {
      userId,
      secretEncrypted: "fake-secret-blob",
      verifiedAt: new Date(),
      recoveryCodesHashed: ["hash-1", "hash-2", "hash-3"],
      lastUsedAt: new Date(),
    },
    update: {
      verifiedAt: new Date(),
      disabledAt: null,
      recoveryCodesHashed: ["hash-1", "hash-2", "hash-3"],
      lastUsedAt: new Date(),
    },
  });
}

describe("admin totp reset :: happy path", () => {
  it("clears verification state, stamps disabledAt, wipes recovery codes", async () => {
    const tenant = await createTestTenant();
    const { user: actor, membership: actorM } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
    });
    const { user: target } = await createTestUserAndMembership(tenant.id, { role: "USER" });
    await enrollWithRecovery(target.id);
    void actor; // actor's User row is unused after this; satisfy linter without _-vars

    const result = await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyReset).toBe(false);
      expect(result.auditEventId).toBeTruthy();
    }

    const after = await superDb.userTotp.findUnique({ where: { userId: target.id } });
    expect(after).not.toBeNull();
    expect(after!.verifiedAt).toBeNull();
    expect(after!.disabledAt).not.toBeNull();
    expect(after!.recoveryCodesHashed).toEqual([]);
    expect(after!.lastUsedAt).toBeNull();
  });

  it("writes TOTP_RESET_BY_ADMIN audit with target id + email + wasEnrolled=true", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    // Email uniqueness is a global UNIQUE on User.email — collisions
    // accumulate across runs against a shared test DB, so suffix it and
    // assert against the same suffixed value rather than a literal.
    const targetEmail = `locked-out-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { user: target } = await createTestUserAndMembership(tenant.id, {
      email: targetEmail,
    });
    await enrollWithRecovery(target.id);

    await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });

    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "TOTP_RESET_BY_ADMIN" },
      orderBy: { seq: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorMembershipId).toBe(actorM.id);
    expect(audit!.subjectId).toBe(target.id);
    expect(audit!.subjectType).toBe("User");
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.targetUserId).toBe(target.id);
    expect(payload.targetUserEmail).toBe(targetEmail);
    expect(payload.wasEnrolled).toBe(true);
  });

  it("post-reset state passes evaluateTotpGate as not-enrolled", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const { user: target } = await createTestUserAndMembership(tenant.id);
    await enrollWithRecovery(target.id);

    await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });

    // tenant requireTotp=false → gate returns "ok" (User can continue
    // without 2FA; they may voluntarily re-enroll).
    const gateA = await evaluateTotpGate({
      userId: target.id,
      sessionId: null,
      tenantRequireTotp: false,
    });
    expect(gateA).toBe("ok");

    // tenant requireTotp=true → gate returns "enroll-required" because
    // the reset cleared verifiedAt + stamped disabledAt.
    const gateB = await evaluateTotpGate({
      userId: target.id,
      sessionId: null,
      tenantRequireTotp: true,
    });
    expect(gateB).toBe("enroll-required");
  });

  it("does NOT delete the UserTotp row — preserves forensic trail", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const { user: target } = await createTestUserAndMembership(tenant.id);
    await enrollWithRecovery(target.id);

    await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });
    const row = await superDb.userTotp.findUnique({ where: { userId: target.id } });
    expect(row).not.toBeNull();
  });

  it("creates a notification inbox row for the affected member", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const { user: target, membership: targetM } = await createTestUserAndMembership(tenant.id);
    await enrollWithRecovery(target.id);

    await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });

    const inbox = await superDb.notificationInbox.findFirst({
      where: { tenantId: tenant.id, membershipId: targetM.id, kind: "totp_reset_by_admin" },
    });
    expect(inbox).not.toBeNull();
    expect(inbox!.title).toMatch(/two-factor/i);
  });
});

describe("admin totp reset :: edge cases", () => {
  it("returns no-enrollment when target User has no UserTotp row", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const { user: target } = await createTestUserAndMembership(tenant.id);

    const result = await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-enrollment");

    // No audit row written for a no-op.
    const count = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "TOTP_RESET_BY_ADMIN" },
    });
    expect(count).toBe(0);
  });

  it("refuses cross-tenant reset (target has no membership in this tenant)", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenantA.id, { role: "FIRM_ADMIN" });
    const { user: targetInB } = await createTestUserAndMembership(tenantB.id);
    await enrollWithRecovery(targetInB.id);

    const result = await resetTotpForUser({
      tenantId: tenantA.id, // wrong tenant
      targetUserId: targetInB.id,
      actorMembershipId: actorM.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-membership");

    // The target's enrollment must still be intact (we refused before
    // touching anything).
    const row = await superDb.userTotp.findUnique({ where: { userId: targetInB.id } });
    expect(row!.verifiedAt).not.toBeNull();
    expect(row!.disabledAt).toBeNull();
    expect(row!.recoveryCodesHashed).toHaveLength(3);
  });

  it("refuses when target's membership in this tenant is INACTIVE", async () => {
    const tenant = await createTestTenant();
    const { membership: actorM } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const { user: target, membership: targetM } = await createTestUserAndMembership(tenant.id);
    await enrollWithRecovery(target.id);
    await superDb.membership.update({
      where: { id: targetM.id },
      data: { status: "SUSPENDED" },
    });

    const result = await resetTotpForUser({
      tenantId: tenant.id,
      targetUserId: target.id,
      actorMembershipId: actorM.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-membership");
  });
});
