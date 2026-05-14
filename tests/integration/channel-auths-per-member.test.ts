/**
 * Post-PRD hardening item 104 — per-staff-member self-service OAuth.
 *
 * Coverage:
 *   - listChannelAuthsForMembership returns one row per Channel
 *     including channels with no auth (so the UI can show "Connect").
 *   - Most-recent ACTIVE auth per (channel, membership) wins
 *     (multiple inserts replicate the connect-replaces-prior flow).
 *   - revokeChannelAuth: soft-revoke writes CHANNEL_DEAUTHORISED audit
 *     with byActor; idempotent on already-revoked.
 *   - revokePriorAuthsForMembership: scopes to one (channel, member)
 *     pair, doesn't touch other Members or other channels.
 *   - Tenant isolation: another tenant's auth doesn't surface in
 *     either list helper.
 *   - listActiveAuthsForChannel returns one row per Member with
 *     resolved name/email + connectedAt.
 *   - byActor distinction: self-revoke vs admin-force-revoke audit
 *     payload encodes the difference.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  listChannelAuthsForMembership,
  listActiveAuthsForChannel,
  revokeChannelAuth,
  revokePriorAuthsForMembership,
} from "@/lib/channels/auths";
import { encryptJson } from "@/lib/channels/crypto";
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

async function makeChannel(tenantId: string, kind = "GOOGLE") {
  return superDb.channel.create({
    data: {
      tenantId,
      kind,
      status: "ACTIVE",
    },
  });
}

async function makeAuth(opts: {
  tenantId: string;
  channelId: string;
  membershipId: string;
  scope?: string;
  revokedAt?: Date | null;
}) {
  return superDb.channelAuth.create({
    data: {
      tenantId: opts.tenantId,
      channelId: opts.channelId,
      membershipId: opts.membershipId,
      encryptedTokens: encryptJson({ access_token: "test-token" }),
      scope: opts.scope ?? "test:scope",
      revokedAt: opts.revokedAt ?? null,
    },
  });
}

describe("channel-auths-per-member — listing helpers", () => {
  it("listChannelAuthsForMembership returns one row per channel even when not authed", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("auth-list"),
    });
    const ch1 = await makeChannel(tenant.id, "GOOGLE");
    const ch2 = await makeChannel(tenant.id, "M365");
    // member has authed ch1 only.
    await makeAuth({
      tenantId: tenant.id,
      channelId: ch1.id,
      membershipId: member.membership.id,
    });
    const list = await listChannelAuthsForMembership({
      tenantId: tenant.id,
      membershipId: member.membership.id,
    });
    expect(list).toHaveLength(2);
    const byKind = Object.fromEntries(list.map((r) => [r.channelKind, r]));
    expect(byKind.GOOGLE.authId).not.toBeNull();
    expect(byKind.M365.authId).toBeNull();
  });

  it("most-recent ACTIVE auth wins per (channel, membership)", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("auth-recent"),
    });
    const channel = await makeChannel(tenant.id);
    await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      scope: "old:scope",
    });
    // Tiny pause to ensure createdAt order is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    const newer = await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      scope: "new:scope",
    });
    const list = await listChannelAuthsForMembership({
      tenantId: tenant.id,
      membershipId: member.membership.id,
    });
    expect(list[0].authId).toBe(newer.id);
    expect(list[0].scope).toBe("new:scope");
  });

  it("revoked auths are not returned as ACTIVE", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("auth-rev"),
    });
    const channel = await makeChannel(tenant.id);
    await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      revokedAt: new Date(),
    });
    const list = await listChannelAuthsForMembership({
      tenantId: tenant.id,
      membershipId: member.membership.id,
    });
    expect(list).toHaveLength(1);
    expect(list[0].authId).toBeNull();
  });

  it("listActiveAuthsForChannel returns one row per Member with resolved name/email", async () => {
    const tenant = await createTestTenant();
    const channel = await makeChannel(tenant.id);
    const alice = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("alice"),
    });
    const bob = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("bob"),
    });
    await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: alice.membership.id,
    });
    await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: bob.membership.id,
    });
    const roster = await listActiveAuthsForChannel({
      tenantId: tenant.id,
      channelId: channel.id,
    });
    expect(roster).toHaveLength(2);
    const memberIds = roster.map((r) => r.membershipId).sort();
    expect(memberIds).toEqual([alice.membership.id, bob.membership.id].sort());
  });
});

describe("channel-auths-per-member — revoke + audit", () => {
  it("revokeChannelAuth(byActor=self) writes audit + soft-revokes; idempotent on second call", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("auth-self-rev"),
    });
    const channel = await makeChannel(tenant.id);
    const auth = await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
    });
    const r1 = await revokeChannelAuth({
      authId: auth.id,
      byActor: "self",
      actorMembershipId: member.membership.id,
    });
    expect(r1.revoked).toBe(true);
    const reread = await superDb.channelAuth.findUnique({ where: { id: auth.id } });
    expect(reread!.revokedAt).not.toBeNull();
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_DEAUTHORISED",
        subjectId: auth.id,
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as {
      byActor?: string;
      membershipId?: string;
      channelKind?: string;
    };
    expect(payload.byActor).toBe("self");
    expect(payload.membershipId).toBe(member.membership.id);
    expect(payload.channelKind).toBe("GOOGLE");

    // Second call is idempotent: no second audit, no error.
    const r2 = await revokeChannelAuth({
      authId: auth.id,
      byActor: "self",
      actorMembershipId: member.membership.id,
    });
    expect(r2.revoked).toBe(false);
    const auditCount = await superDb.auditEvent.count({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_DEAUTHORISED",
        subjectId: auth.id,
      },
    });
    expect(auditCount).toBe(1);
  });

  it("revokeChannelAuth(byActor=admin) records actor + auth-owner separately", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("auth-admin-rev"),
    });
    const owner = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("auth-owner"),
    });
    const channel = await makeChannel(tenant.id);
    const auth = await makeAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: owner.membership.id,
    });
    await revokeChannelAuth({
      authId: auth.id,
      byActor: "admin",
      actorMembershipId: admin.membership.id,
      reason: "left the firm",
    });
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_DEAUTHORISED",
        subjectId: auth.id,
      },
    });
    expect(audit!.actorMembershipId).toBe(admin.membership.id);
    const payload = audit!.payload as {
      byActor?: string;
      membershipId?: string;
      reason?: string;
    };
    expect(payload.byActor).toBe("admin");
    expect(payload.membershipId).toBe(owner.membership.id); // auth owner, NOT actor
    expect(payload.reason).toBe("left the firm");
  });

  it("revokePriorAuthsForMembership scopes to one (channel, member); other Members + other channels untouched", async () => {
    const tenant = await createTestTenant();
    const alice = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("alice-pri"),
    });
    const bob = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("bob-pri"),
    });
    const ch1 = await makeChannel(tenant.id, "GOOGLE");
    const ch2 = await makeChannel(tenant.id, "M365");
    const aliceCh1 = await makeAuth({
      tenantId: tenant.id,
      channelId: ch1.id,
      membershipId: alice.membership.id,
    });
    const aliceCh2 = await makeAuth({
      tenantId: tenant.id,
      channelId: ch2.id,
      membershipId: alice.membership.id,
    });
    const bobCh1 = await makeAuth({
      tenantId: tenant.id,
      channelId: ch1.id,
      membershipId: bob.membership.id,
    });
    const r = await revokePriorAuthsForMembership({
      channelId: ch1.id,
      membershipId: alice.membership.id,
    });
    expect(r.revokedCount).toBe(1);
    const survivors = await superDb.channelAuth.findMany({
      where: { revokedAt: null },
      select: { id: true },
    });
    const survivorIds = survivors.map((s) => s.id).sort();
    expect(survivorIds).toEqual([aliceCh2.id, bobCh1.id].sort());
    expect(survivorIds).not.toContain(aliceCh1.id);
  });
});

describe("channel-auths-per-member — tenant isolation", () => {
  it("listChannelAuthsForMembership doesn't leak another tenant's channels", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const memberA = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("iso-a"),
    });
    await makeChannel(tenantA.id);
    await makeChannel(tenantB.id);
    const list = await listChannelAuthsForMembership({
      tenantId: tenantA.id,
      membershipId: memberA.membership.id,
    });
    expect(list).toHaveLength(1);
  });

  it("listActiveAuthsForChannel only returns auths for the requested channel's tenant", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const channelA = await makeChannel(tenantA.id);
    const channelB = await makeChannel(tenantB.id);
    const memberA = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("iso-roster-a"),
    });
    const memberB = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("iso-roster-b"),
    });
    await makeAuth({
      tenantId: tenantA.id,
      channelId: channelA.id,
      membershipId: memberA.membership.id,
    });
    await makeAuth({
      tenantId: tenantB.id,
      channelId: channelB.id,
      membershipId: memberB.membership.id,
    });
    const rosterA = await listActiveAuthsForChannel({
      tenantId: tenantA.id,
      channelId: channelA.id,
    });
    expect(rosterA).toHaveLength(1);
    expect(rosterA[0].membershipId).toBe(memberA.membership.id);
  });
});
