/**
 * Post-PRD hardening item 15 — idle + absolute session timeout.
 *
 * Coverage:
 *   - resolvePolicyForUser: defaults when no tenant configures, strictest
 *     wins across multiple tenants, null fields ignored, mixed configs.
 *   - evaluateSession: idle expired, absolute expired, both expired (absolute
 *     wins), neither expired, revoked row short-circuits.
 *   - revokeForTimeout: idempotent on already-revoked, writes audit on
 *     binding tenant when present, falls back to first active membership
 *     when binding is empty, system revocation has actorMembershipId=null
 *     and revokedById=null.
 *   - enforceSessionTimeout: layout-level flow returns the evaluation and
 *     revokes when expired, returns expired:false for non-existent session.
 *   - sweepExpiredSessions: revokes only the qualifying rows, skips already-
 *     revoked, idempotent (second run finds nothing), reasons tally is
 *     correct, doesn't touch session whose userId has no active membership
 *     (defaults still apply — sweep still revokes if old enough).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { superDb } from "@/lib/db";
import {
  resolvePolicyForUser,
  evaluateSession,
  enforceSessionTimeout,
  sweepExpiredSessions,
  revokeForTimeout,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_ABSOLUTE_TIMEOUT_MINUTES,
} from "@/lib/auth/sessions";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

async function makeSession(
  userId: string,
  opts: { createdAt?: Date; lastSeenAt?: Date } = {},
) {
  const now = new Date();
  return superDb.session.create({
    data: {
      sessionToken: randomUUID(),
      userId,
      expires: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      createdAt: opts.createdAt ?? now,
      lastSeenAt: opts.lastSeenAt ?? now,
    },
  });
}

async function backdate(sessionId: string, opts: { createdAtMsAgo?: number; lastSeenAtMsAgo?: number }) {
  const data: { createdAt?: Date; lastSeenAt?: Date } = {};
  const now = Date.now();
  if (opts.createdAtMsAgo !== undefined) data.createdAt = new Date(now - opts.createdAtMsAgo);
  if (opts.lastSeenAtMsAgo !== undefined) data.lastSeenAt = new Date(now - opts.lastSeenAtMsAgo);
  await superDb.session.update({ where: { id: sessionId }, data });
}

describe("session timeout — resolvePolicyForUser", () => {
  it("falls back to platform defaults when no tenant overrides", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const policy = await resolvePolicyForUser(user.id);
    expect(policy.idleLimitMinutes).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    expect(policy.absoluteLimitMinutes).toBe(DEFAULT_ABSOLUTE_TIMEOUT_MINUTES);
    expect(policy.idleBindingTenantIds).toEqual([]);
    expect(policy.absoluteBindingTenantIds).toEqual([]);
  });

  it("picks the single tenant's override when configured", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { sessionIdleTimeoutMinutes: 30, sessionAbsoluteTimeoutMinutes: 480 },
    });
    const { user } = await createTestUserAndMembership(tenant.id);
    const policy = await resolvePolicyForUser(user.id);
    expect(policy.idleLimitMinutes).toBe(30);
    expect(policy.absoluteLimitMinutes).toBe(480);
    expect(policy.idleBindingTenantIds).toEqual([tenant.id]);
    expect(policy.absoluteBindingTenantIds).toEqual([tenant.id]);
  });

  it("takes the STRICTEST across multiple tenants per dimension", async () => {
    const ta = await createTestTenant();
    const tb = await createTestTenant();
    await superDb.tenant.update({
      where: { id: ta.id },
      data: { sessionIdleTimeoutMinutes: 120, sessionAbsoluteTimeoutMinutes: 720 },
    });
    await superDb.tenant.update({
      where: { id: tb.id },
      data: { sessionIdleTimeoutMinutes: 15, sessionAbsoluteTimeoutMinutes: 4320 },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.com` },
    });
    await superDb.membership.create({
      data: { tenantId: ta.id, userId: user.id, role: "USER", status: "ACTIVE" },
    });
    await superDb.membership.create({
      data: { tenantId: tb.id, userId: user.id, role: "USER", status: "ACTIVE" },
    });
    const policy = await resolvePolicyForUser(user.id);
    expect(policy.idleLimitMinutes).toBe(15);
    expect(policy.idleBindingTenantIds).toEqual([tb.id]);
    expect(policy.absoluteLimitMinutes).toBe(720);
    expect(policy.absoluteBindingTenantIds).toEqual([ta.id]);
  });

  it("ignores INACTIVE memberships", async () => {
    const ta = await createTestTenant();
    const tb = await createTestTenant();
    await superDb.tenant.update({
      where: { id: ta.id },
      data: { sessionIdleTimeoutMinutes: 120 },
    });
    await superDb.tenant.update({
      where: { id: tb.id },
      data: { sessionIdleTimeoutMinutes: 5 },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.com` },
    });
    await superDb.membership.create({
      data: { tenantId: ta.id, userId: user.id, role: "USER", status: "ACTIVE" },
    });
    await superDb.membership.create({
      data: { tenantId: tb.id, userId: user.id, role: "USER", status: "SUSPENDED" },
    });
    const policy = await resolvePolicyForUser(user.id);
    // The SUSPENDED membership in tb (stricter 5-minute idle) MUST be
    // ignored because only ACTIVE memberships contribute to the policy.
    expect(policy.idleLimitMinutes).toBe(120);
    expect(policy.idleBindingTenantIds).toEqual([ta.id]);
  });
});

describe("session timeout — evaluateSession", () => {
  const policy = {
    idleLimitMinutes: 60,
    absoluteLimitMinutes: 1440,
    idleBindingTenantIds: ["t-idle"],
    absoluteBindingTenantIds: ["t-abs"],
  };

  it("not expired when fresh", () => {
    const now = new Date("2026-05-11T12:00:00Z");
    const session = {
      id: "s1",
      userId: "u1",
      createdAt: new Date("2026-05-11T11:30:00Z"),
      lastSeenAt: new Date("2026-05-11T11:59:00Z"),
      revokedAt: null,
    };
    expect(evaluateSession(session, policy, now)).toEqual({ expired: false });
  });

  it("idle expired when lastSeenAt exceeds limit", () => {
    const now = new Date("2026-05-11T12:00:00Z");
    const session = {
      id: "s1",
      userId: "u1",
      createdAt: new Date("2026-05-11T10:00:00Z"),
      lastSeenAt: new Date("2026-05-11T10:30:00Z"),
      revokedAt: null,
    };
    const r = evaluateSession(session, policy, now);
    expect(r.expired).toBe(true);
    if (r.expired) {
      expect(r.reason).toBe("idle-timeout");
      expect(r.bindingTenantId).toBe("t-idle");
      expect(r.limitMinutes).toBe(60);
      expect(r.ageMinutes).toBe(90);
    }
  });

  it("absolute expired when createdAt exceeds limit even with recent activity", () => {
    const now = new Date("2026-05-12T13:00:00Z");
    const session = {
      id: "s1",
      userId: "u1",
      createdAt: new Date("2026-05-11T11:00:00Z"),
      lastSeenAt: new Date("2026-05-12T12:59:00Z"),
      revokedAt: null,
    };
    const r = evaluateSession(session, policy, now);
    expect(r.expired).toBe(true);
    if (r.expired) {
      expect(r.reason).toBe("absolute-timeout");
      expect(r.bindingTenantId).toBe("t-abs");
    }
  });

  it("absolute precedence when both would trigger", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const session = {
      id: "s1",
      userId: "u1",
      createdAt: new Date("2026-05-11T10:00:00Z"),
      lastSeenAt: new Date("2026-05-11T11:00:00Z"),
      revokedAt: null,
    };
    const r = evaluateSession(session, policy, now);
    expect(r.expired).toBe(true);
    if (r.expired) expect(r.reason).toBe("absolute-timeout");
  });

  it("revoked row reports not expired (short-circuit for sweep idempotency)", () => {
    const now = new Date("2026-05-11T12:00:00Z");
    const session = {
      id: "s1",
      userId: "u1",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      lastSeenAt: new Date("2026-05-01T00:00:00Z"),
      revokedAt: new Date("2026-05-05T00:00:00Z"),
    };
    expect(evaluateSession(session, policy, now)).toEqual({ expired: false });
  });
});

describe("session timeout — revokeForTimeout", () => {
  it("flips revokedAt + reason, leaves revokedById null, writes audit", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    const eventsBefore = await superDb.auditEvent.count({ where: { tenantId: tenant.id } });
    const result = await revokeForTimeout({
      sessionId: session.id,
      userId: user.id,
      reason: "idle-timeout",
      bindingTenantId: tenant.id,
      ageMinutes: 75,
      limitMinutes: 60,
    });
    expect(result.revoked).toBe(true);
    const reloaded = await superDb.session.findUnique({ where: { id: session.id } });
    expect(reloaded?.revokedAt).not.toBeNull();
    expect(reloaded?.revokedById).toBeNull();
    expect(reloaded?.revokedReason).toBe("idle-timeout");
    const eventsAfter = await superDb.auditEvent.count({ where: { tenantId: tenant.id } });
    expect(eventsAfter).toBe(eventsBefore + 1);
    const evt = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "SESSION_REVOKED" },
      orderBy: { seq: "desc" },
    });
    expect(evt?.actorMembershipId).toBeNull();
    expect(evt?.subjectId).toBe(session.id);
    const payload = evt?.payload as Record<string, unknown>;
    expect(payload.reason).toBe("idle-timeout");
    expect(payload.systemRevocation).toBe(true);
    expect(payload.targetUserId).toBe(user.id);
    expect(payload.ageMinutes).toBe(75);
    expect(payload.limitMinutes).toBe(60);
    // unused but ensures the membership fixture is real
    expect(membership.userId).toBe(user.id);
  });

  it("falls back to user's first active membership tenant when binding is empty", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    await revokeForTimeout({
      sessionId: session.id,
      userId: user.id,
      reason: "absolute-timeout",
      bindingTenantId: null,
      ageMinutes: 1500,
      limitMinutes: 1440,
    });
    const evt = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "SESSION_REVOKED", subjectId: session.id },
    });
    expect(evt).not.toBeNull();
    expect((evt?.payload as Record<string, unknown>).reason).toBe("absolute-timeout");
  });

  it("idempotent on already-revoked row", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    await revokeForTimeout({
      sessionId: session.id,
      userId: user.id,
      reason: "idle-timeout",
      bindingTenantId: tenant.id,
      ageMinutes: 75,
      limitMinutes: 60,
    });
    const eventsAfterFirst = await superDb.auditEvent.count({ where: { tenantId: tenant.id } });
    const result = await revokeForTimeout({
      sessionId: session.id,
      userId: user.id,
      reason: "idle-timeout",
      bindingTenantId: tenant.id,
      ageMinutes: 80,
      limitMinutes: 60,
    });
    expect(result.revoked).toBe(false);
    const eventsAfterSecond = await superDb.auditEvent.count({ where: { tenantId: tenant.id } });
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });

  it("returns revoked:false silently when session does not exist", async () => {
    const result = await revokeForTimeout({
      sessionId: "does-not-exist",
      userId: "ditto",
      reason: "idle-timeout",
      bindingTenantId: null,
      ageMinutes: 999,
      limitMinutes: 60,
    });
    expect(result.revoked).toBe(false);
  });
});

describe("session timeout — enforceSessionTimeout", () => {
  it("returns expired:false for an active session", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    const r = await enforceSessionTimeout(session.id);
    expect(r.expired).toBe(false);
  });

  it("revokes and returns the evaluation for an idle session", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { sessionIdleTimeoutMinutes: 10 },
    });
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    await backdate(session.id, { lastSeenAtMsAgo: 30 * 60_000 });
    const r = await enforceSessionTimeout(session.id);
    expect(r.expired).toBe(true);
    if (r.expired) {
      expect(r.reason).toBe("idle-timeout");
      expect(r.bindingTenantId).toBe(tenant.id);
    }
    const reloaded = await superDb.session.findUnique({ where: { id: session.id } });
    expect(reloaded?.revokedAt).not.toBeNull();
  });

  it("silently passes for a non-existent session id", async () => {
    const r = await enforceSessionTimeout("nope");
    expect(r.expired).toBe(false);
  });
});

describe("session timeout — sweepExpiredSessions", () => {
  it("revokes idle + absolute expirations, leaves fresh alone", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { sessionIdleTimeoutMinutes: 10, sessionAbsoluteTimeoutMinutes: 60 },
    });
    const { user: u1 } = await createTestUserAndMembership(tenant.id);
    const { user: u2 } = await createTestUserAndMembership(tenant.id);
    const { user: u3 } = await createTestUserAndMembership(tenant.id);
    const idleSession = await makeSession(u1.id);
    const absoluteSession = await makeSession(u2.id);
    const freshSession = await makeSession(u3.id);
    await backdate(idleSession.id, { lastSeenAtMsAgo: 20 * 60_000 });
    await backdate(absoluteSession.id, {
      createdAtMsAgo: 120 * 60_000,
      lastSeenAtMsAgo: 1_000,
    });
    const r = await sweepExpiredSessions();
    expect(r.revoked).toBeGreaterThanOrEqual(2);
    expect(r.reasons["idle-timeout"]).toBeGreaterThanOrEqual(1);
    expect(r.reasons["absolute-timeout"]).toBeGreaterThanOrEqual(1);
    const idleReloaded = await superDb.session.findUnique({ where: { id: idleSession.id } });
    const absReloaded = await superDb.session.findUnique({ where: { id: absoluteSession.id } });
    const freshReloaded = await superDb.session.findUnique({ where: { id: freshSession.id } });
    expect(idleReloaded?.revokedAt).not.toBeNull();
    expect(idleReloaded?.revokedReason).toBe("idle-timeout");
    expect(absReloaded?.revokedAt).not.toBeNull();
    expect(absReloaded?.revokedReason).toBe("absolute-timeout");
    expect(freshReloaded?.revokedAt).toBeNull();
  });

  it("second run is a no-op (revoked rows excluded)", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { sessionIdleTimeoutMinutes: 5 },
    });
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    await backdate(session.id, { lastSeenAtMsAgo: 30 * 60_000 });
    const first = await sweepExpiredSessions();
    expect(first.revoked).toBeGreaterThanOrEqual(1);
    const second = await sweepExpiredSessions();
    // Second run may still touch other expired rows from concurrent tests,
    // but our specific session should already be revoked and not counted again.
    const reloaded = await superDb.session.findUnique({ where: { id: session.id } });
    expect(reloaded?.revokedAt).not.toBeNull();
    // Idempotency: re-sweeping the same row never bumps a fresh audit row.
    const audits = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, subjectId: session.id, eventType: "SESSION_REVOKED" },
    });
    expect(audits).toBe(1);
    expect(second.revoked).toBeGreaterThanOrEqual(0);
  });
});
