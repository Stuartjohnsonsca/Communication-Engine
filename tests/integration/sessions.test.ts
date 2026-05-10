/**
 * Post-PRD hardening item 13 — session management + per-session revocation.
 *
 * Coverage:
 *  - touchSession bumps lastSeenAt and is throttled (back-dated row updates;
 *    fresh row does not).
 *  - observeSessionMetadata is first-observation-wins (a later call cannot
 *    overwrite values once set).
 *  - revokeSession sets revokedAt + revokedBy + revokedReason and writes a
 *    SESSION_REVOKED audit on the actor's tenant chain.
 *  - revokeSession with reason="admin-revoke" writes SESSION_REVOKED_BY_ADMIN
 *    instead.
 *  - revokeSession is idempotent (second call no-ops, no duplicate audit).
 *  - revokeAllSessionsForUser revokes every non-excluded session and writes
 *    a single SESSION_REVOKED_ALL audit with revokedCount in the payload.
 *  - revokeAllSessionsForUser respects excludeSessionId.
 *  - listSessionsForUser hides revoked rows by default; surfaces them with
 *    includeRevoked.
 *  - listSessionsForUser marks the current session via currentSessionId.
 *  - listActiveSessionsInTenant only includes users with ACTIVE memberships
 *    in that tenant; ignores revoked sessions.
 *  - describeUserAgent classifies the common browser/OS combinations.
 *  - ipFromHeaders precedence (xff first-hop wins) + maskIp shape.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { superDb } from "@/lib/db";
import {
  touchSession,
  observeSessionMetadata,
  revokeSession,
  revokeAllSessionsForUser,
  listSessionsForUser,
  listActiveSessionsInTenant,
  describeUserAgent,
  ipFromHeaders,
  maskIp,
} from "@/lib/auth/sessions";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

async function makeSession(
  userId: string,
  opts: { userAgent?: string | null; ipAddress?: string | null } = {},
) {
  return superDb.session.create({
    data: {
      sessionToken: randomUUID(),
      userId,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    },
  });
}

async function backdateLastSeen(sessionId: string, deltaMs: number) {
  await superDb.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(Date.now() - deltaMs) },
  });
}

describe("describeUserAgent", () => {
  it("classifies common combos", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ).label,
    ).toBe("Chrome on macOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ).label,
    ).toBe("Safari on iOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      ).label,
    ).toBe("Edge on Windows");
    expect(describeUserAgent("curl/8.4.0").label).toBe("curl on Unknown");
    expect(describeUserAgent(null).label).toBe("Unknown device");
  });
});

describe("ipFromHeaders + maskIp", () => {
  it("picks first hop of XFF", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" });
    expect(ipFromHeaders(h)).toBe("203.0.113.7");
  });
  it("falls back through the precedence chain", () => {
    expect(ipFromHeaders(new Headers({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(ipFromHeaders(new Headers({ "cf-connecting-ip": "198.51.100.2" }))).toBe(
      "198.51.100.2",
    );
    expect(ipFromHeaders(new Headers())).toBeNull();
  });
  it("masks v4 + v6 + leaves localhost intact", () => {
    expect(maskIp("203.0.113.7")).toBe("203.0.113.×");
    expect(maskIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3:0:…");
    expect(maskIp("127.0.0.1")).toBe("127.0.0.1");
    expect(maskIp(null)).toBe("—");
  });
});

describe("touchSession", () => {
  it("bumps lastSeenAt when the row is stale and skips when fresh", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);

    // Fresh row: lastSeenAt is < 60s old, touch should be a no-op.
    await touchSession(s.id);
    const afterFresh = await superDb.session.findUnique({ where: { id: s.id } });
    expect(afterFresh!.lastSeenAt.getTime()).toBe(s.lastSeenAt.getTime());

    // Back-date to 5 minutes ago and touch — should bump.
    await backdateLastSeen(s.id, 5 * 60_000);
    await touchSession(s.id);
    const afterStale = await superDb.session.findUnique({ where: { id: s.id } });
    expect(afterStale!.lastSeenAt.getTime()).toBeGreaterThan(s.lastSeenAt.getTime());
  });

  it("ignores revoked sessions", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);
    await revokeSession({
      sessionId: s.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    await backdateLastSeen(s.id, 5 * 60_000);
    const before = await superDb.session.findUnique({ where: { id: s.id } });
    await touchSession(s.id);
    const after = await superDb.session.findUnique({ where: { id: s.id } });
    expect(after!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
  });
});

describe("observeSessionMetadata", () => {
  it("is first-observation-wins for userAgent + ipAddress", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);

    await observeSessionMetadata(s.id, "Chrome on macOS", "203.0.113.10");
    const first = await superDb.session.findUnique({ where: { id: s.id } });
    expect(first!.userAgent).toBe("Chrome on macOS");
    expect(first!.ipAddress).toBe("203.0.113.10");

    // A subsequent call must NOT overwrite — defends against header spoofing
    // mid-session.
    await observeSessionMetadata(s.id, "Spoofed UA", "1.2.3.4");
    const second = await superDb.session.findUnique({ where: { id: s.id } });
    expect(second!.userAgent).toBe("Chrome on macOS");
    expect(second!.ipAddress).toBe("203.0.113.10");
  });

  it("ignores null fields and clamps length", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);
    await observeSessionMetadata(s.id, null, null);
    const after = await superDb.session.findUnique({ where: { id: s.id } });
    expect(after!.userAgent).toBeNull();
    expect(after!.ipAddress).toBeNull();

    const huge = "x".repeat(2000);
    await observeSessionMetadata(s.id, huge, huge);
    const clamped = await superDb.session.findUnique({ where: { id: s.id } });
    expect(clamped!.userAgent!.length).toBeLessThanOrEqual(512);
    expect(clamped!.ipAddress!.length).toBeLessThanOrEqual(64);
  });
});

describe("revokeSession", () => {
  it("marks the row revoked + writes SESSION_REVOKED audit on user-self", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);
    const r = await revokeSession({
      sessionId: s.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    expect(r.revoked).toBe(true);
    expect(r.targetUserId).toBe(user.id);

    const row = await superDb.session.findUnique({ where: { id: s.id } });
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedById).toBe(user.id);
    expect(row!.revokedReason).toBe("user-self");

    const event = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "SESSION_REVOKED",
        subjectId: s.id,
      },
    });
    expect(event).not.toBeNull();
  });

  it("writes SESSION_REVOKED_BY_ADMIN when reason is admin-revoke", async () => {
    const tenant = await createTestTenant();
    const { user: target } = await createTestUserAndMembership(tenant.id);
    const { user: admin, membership: adminM } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
    });
    const s = await makeSession(target.id);
    await revokeSession({
      sessionId: s.id,
      reason: "admin-revoke",
      ctx: { tenantId: tenant.id, actorMembershipId: adminM.id, actorUserId: admin.id },
    });
    const event = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "SESSION_REVOKED_BY_ADMIN",
        subjectId: s.id,
      },
    });
    expect(event).not.toBeNull();
  });

  it("is idempotent on a second call", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);
    await revokeSession({
      sessionId: s.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    const r2 = await revokeSession({
      sessionId: s.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    expect(r2.revoked).toBe(false);
    const events = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id, subjectId: s.id, eventType: "SESSION_REVOKED" },
    });
    expect(events.length).toBe(1);
  });
});

describe("revokeAllSessionsForUser", () => {
  it("revokes every non-excluded session and writes one SESSION_REVOKED_ALL", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const [s1, s2, s3] = await Promise.all([
      makeSession(user.id),
      makeSession(user.id),
      makeSession(user.id),
    ]);

    const r = await revokeAllSessionsForUser({
      targetUserId: user.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
      excludeSessionId: s2.id,
    });
    expect(r.revoked).toBe(2);

    const after = await superDb.session.findMany({ where: { userId: user.id } });
    const byId = new Map(after.map((s) => [s.id, s]));
    expect(byId.get(s1.id)!.revokedAt).not.toBeNull();
    expect(byId.get(s2.id)!.revokedAt).toBeNull();
    expect(byId.get(s3.id)!.revokedAt).not.toBeNull();

    const events = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "SESSION_REVOKED_ALL",
        subjectId: user.id,
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as { revokedCount: number; excludeSessionId: string | null };
    expect(payload.revokedCount).toBe(2);
    expect(payload.excludeSessionId).toBe(s2.id);
  });

  it("writes no audit event when nothing was actually revoked", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const r = await revokeAllSessionsForUser({
      targetUserId: user.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    expect(r.revoked).toBe(0);
    const events = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id, eventType: "SESSION_REVOKED_ALL" },
    });
    expect(events.length).toBe(0);
  });
});

describe("listSessionsForUser", () => {
  it("hides revoked sessions by default and marks the current one", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const s1 = await makeSession(user.id, { userAgent: "Chrome" });
    const s2 = await makeSession(user.id, { userAgent: "Firefox" });

    await revokeSession({
      sessionId: s2.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });

    const live = await listSessionsForUser({
      userId: user.id,
      currentSessionId: s1.id,
    });
    expect(live.map((s) => s.id)).toEqual([s1.id]);
    expect(live[0]!.isCurrent).toBe(true);

    const all = await listSessionsForUser({
      userId: user.id,
      currentSessionId: s1.id,
      includeRevoked: true,
    });
    expect(all.length).toBe(2);
  });
});

describe("listActiveSessionsInTenant", () => {
  it("only returns sessions for ACTIVE members of the requested tenant", async () => {
    const tA = await createTestTenant();
    const tB = await createTestTenant();
    const { user: alice } = await createTestUserAndMembership(tA.id, { role: "USER" });
    const { user: bob } = await createTestUserAndMembership(tA.id, { role: "FIRM_ADMIN" });
    // Charlie is only a member of tenant B; their session must not appear
    // in tenant A's list.
    const { user: charlie } = await createTestUserAndMembership(tB.id);

    await Promise.all([
      makeSession(alice.id, { userAgent: "Alice browser" }),
      makeSession(bob.id, { userAgent: "Bob browser" }),
      makeSession(charlie.id, { userAgent: "Charlie browser" }),
    ]);

    const entriesA = await listActiveSessionsInTenant(tA.id);
    const ids = entriesA.map((e) => e.user.id).sort();
    expect(ids).toEqual([alice.id, bob.id].sort());

    const entriesB = await listActiveSessionsInTenant(tB.id);
    expect(entriesB.map((e) => e.user.id)).toEqual([charlie.id]);
  });

  it("excludes a User whose only sessions are all revoked", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id);
    const s = await makeSession(user.id);
    await revokeSession({
      sessionId: s.id,
      reason: "user-self",
      ctx: { tenantId: tenant.id, actorMembershipId: membership.id, actorUserId: user.id },
    });
    const entries = await listActiveSessionsInTenant(tenant.id);
    expect(entries.length).toBe(0);
  });
});
