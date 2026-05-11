/**
 * Post-PRD hardening item 18 — step-up authentication.
 *
 * Coverage:
 *  - evaluateStepUp returns:
 *      "fresh" when totpVerifiedAt is within the window,
 *      "stale" when totpVerifiedAt is older than the window,
 *      "stale" when totpVerifiedAt is null but TOTP is enrolled,
 *      "no-totp" when the User has no enrollment.
 *  - resolveEffectiveStepUpWindow returns:
 *      DEFAULT when all memberships have null overrides,
 *      single-tenant override when only one membership has it set,
 *      MIN across non-null values for multi-tenant Users,
 *      ignores INACTIVE memberships (a SUSPENDED tenant can't
 *        influence policy).
 *  - requireStepUp:
 *      returns silently on fresh,
 *      throws StepUpRequired{nextUrl, opKey, reason} on stale,
 *      throws StepUpRequired with reason="no-totp" when User has no TOTP.
 *  - recordStepUpVerified writes STEP_UP_VERIFIED to the tenant chain
 *    with the opKey in payload.
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { randomUUID } from "node:crypto";
import {
  evaluateStepUp,
  resolveEffectiveStepUpWindow,
  requireStepUp,
  recordStepUpVerified,
  StepUpRequired,
  DEFAULT_STEP_UP_MAX_AGE_MINUTES,
} from "@/lib/auth/totp";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

async function makeSession(userId: string, totpVerifiedAt: Date | null = null) {
  return superDb.session.create({
    data: {
      sessionToken: randomUUID(),
      userId,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      totpVerifiedAt,
    },
  });
}

async function enrollTotp(userId: string) {
  return superDb.userTotp.upsert({
    where: { userId },
    create: {
      userId,
      secretEncrypted: "fake-secret-blob",
      verifiedAt: new Date(),
      recoveryCodesHashed: [],
    },
    update: {
      verifiedAt: new Date(),
      disabledAt: null,
    },
  });
}

describe("step-up :: evaluateStepUp", () => {
  it("returns 'fresh' when totpVerifiedAt is within the window", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    const session = await makeSession(user.id, new Date(Date.now() - 2 * 60_000)); // 2 min ago

    const result = await evaluateStepUp({
      sessionId: session.id,
      userId: user.id,
      tenantStepUpMaxAgeMinutes: 5,
    });
    expect(result.status).toBe("fresh");
    expect(result.maxAgeMinutes).toBe(5);
    expect(result.ageMinutes).toBeLessThan(5);
  });

  it("returns 'stale' when totpVerifiedAt is older than the window", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    const session = await makeSession(user.id, new Date(Date.now() - 30 * 60_000)); // 30 min ago

    const result = await evaluateStepUp({
      sessionId: session.id,
      userId: user.id,
      tenantStepUpMaxAgeMinutes: 5,
    });
    expect(result.status).toBe("stale");
    expect(result.ageMinutes).toBeGreaterThan(5);
  });

  it("returns 'stale' when session has no totpVerifiedAt but TOTP enrolled", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    const session = await makeSession(user.id, null);

    const result = await evaluateStepUp({
      sessionId: session.id,
      userId: user.id,
      tenantStepUpMaxAgeMinutes: 5,
    });
    expect(result.status).toBe("stale");
    expect(result.ageMinutes).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns 'no-totp' when User has no enrollment", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    // No enrollTotp call.
    const session = await makeSession(user.id, new Date());

    const result = await evaluateStepUp({
      sessionId: session.id,
      userId: user.id,
      tenantStepUpMaxAgeMinutes: 5,
    });
    expect(result.status).toBe("no-totp");
  });

  it("treats a disabled TOTP enrollment as no-totp", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    await superDb.userTotp.update({
      where: { userId: user.id },
      data: { disabledAt: new Date() },
    });
    const session = await makeSession(user.id, new Date());

    const result = await evaluateStepUp({
      sessionId: session.id,
      userId: user.id,
      tenantStepUpMaxAgeMinutes: 5,
    });
    expect(result.status).toBe("no-totp");
  });
});

describe("step-up :: resolveEffectiveStepUpWindow", () => {
  it("returns default when no membership has an override", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const result = await resolveEffectiveStepUpWindow(user.id);
    expect(result.maxAgeMinutes).toBe(DEFAULT_STEP_UP_MAX_AGE_MINUTES);
    expect(result.bindingTenantIds).toEqual([]);
  });

  it("returns the single-tenant override when one is configured", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { stepUpMaxAgeMinutes: 2 },
    });
    const result = await resolveEffectiveStepUpWindow(user.id);
    expect(result.maxAgeMinutes).toBe(2);
    expect(result.bindingTenantIds).toEqual([tenant.id]);
  });

  it("returns the strictest (smallest) value across multi-tenant memberships", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenantA.id);
    await superDb.membership.create({
      data: {
        tenantId: tenantB.id,
        userId: user.id,
        role: "USER",
        status: "ACTIVE",
      },
    });
    await superDb.tenant.update({ where: { id: tenantA.id }, data: { stepUpMaxAgeMinutes: 10 } });
    await superDb.tenant.update({ where: { id: tenantB.id }, data: { stepUpMaxAgeMinutes: 3 } });

    const result = await resolveEffectiveStepUpWindow(user.id);
    expect(result.maxAgeMinutes).toBe(3);
    expect(result.bindingTenantIds).toEqual([tenantB.id]);
  });

  it("ignores INACTIVE memberships when resolving policy", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenantA.id);
    await superDb.membership.create({
      data: {
        tenantId: tenantB.id,
        userId: user.id,
        role: "USER",
        status: "SUSPENDED",
      },
    });
    // tenantB has the stricter policy, but the User's membership in B
    // is SUSPENDED so its policy must not influence the effective
    // window.
    await superDb.tenant.update({ where: { id: tenantA.id }, data: { stepUpMaxAgeMinutes: 10 } });
    await superDb.tenant.update({ where: { id: tenantB.id }, data: { stepUpMaxAgeMinutes: 1 } });

    const result = await resolveEffectiveStepUpWindow(user.id);
    expect(result.maxAgeMinutes).toBe(10);
    expect(result.bindingTenantIds).toEqual([tenantA.id]);
  });
});

describe("step-up :: requireStepUp", () => {
  it("returns silently on fresh", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    const session = await makeSession(user.id, new Date(Date.now() - 60_000));

    await expect(
      requireStepUp({
        sessionId: session.id,
        userId: user.id,
        tenantStepUpMaxAgeMinutes: 5,
        nextUrl: "/x/admin/security",
        opKey: "test-op",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws StepUpRequired{reason='stale', nextUrl, opKey} on stale", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    await enrollTotp(user.id);
    const session = await makeSession(user.id, new Date(Date.now() - 30 * 60_000));

    try {
      await requireStepUp({
        sessionId: session.id,
        userId: user.id,
        tenantStepUpMaxAgeMinutes: 5,
        nextUrl: "/x/admin/security",
        opKey: "test-op",
      });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StepUpRequired);
      if (err instanceof StepUpRequired) {
        expect(err.reason).toBe("stale");
        expect(err.nextUrl).toBe("/x/admin/security");
        expect(err.opKey).toBe("test-op");
        expect(err.status).toBe(401);
      }
    }
  });

  it("throws StepUpRequired{reason='no-totp'} when User has no enrollment", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id, new Date());

    try {
      await requireStepUp({
        sessionId: session.id,
        userId: user.id,
        tenantStepUpMaxAgeMinutes: 5,
        nextUrl: "/x/admin/security",
        opKey: "test-op",
      });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StepUpRequired);
      if (err instanceof StepUpRequired) expect(err.reason).toBe("no-totp");
    }
  });
});

describe("step-up :: recordStepUpVerified", () => {
  it("writes STEP_UP_VERIFIED to the tenant chain with opKey in payload", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });

    await recordStepUpVerified({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      opKey: "ip-allowlist-change",
    });

    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "STEP_UP_VERIFIED" },
      orderBy: { seq: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorMembershipId).toBe(membership.id);
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.opKey).toBe("ip-allowlist-change");
  });
});
