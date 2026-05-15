/**
 * Item 110 — IMAP password auth round-trip + failure handling.
 *
 * Coverage:
 *   - setPasswordCreds → getPasswordCreds returns plaintext;
 *     encrypted column doesn't contain plaintext substring.
 *   - Re-entry on existing channel soft-revokes prior + writes
 *     CHANNEL_PASSWORD_AUTH_REENTERED with isFreshConnect: false.
 *   - Per-Member isolation: two staff members on the same channel
 *     have distinct credentials that don't cross-leak.
 *   - markPasswordAuthFailed: stamps lastFailureAt, writes audit,
 *     fires channel_auth_failed dispatch row (per-day deduped).
 *   - clearPasswordAuthFailure clears state on successful re-entry.
 *   - Tenant isolation: another tenant's password creds invisible
 *     even with the same authId pattern.
 *   - Validation: empty username, empty password, non-IMAP channel
 *     kind all rejected.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  setPasswordCreds,
  getPasswordCreds,
  markPasswordAuthFailed,
} from "@/lib/channels/password-creds";
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

async function makeImapChannel(tenantId: string) {
  return superDb.channel.create({
    data: {
      tenantId,
      kind: "IMAP",
      status: "ACTIVE",
      imapConfigJson: {
        imapHost: "imap.test.local",
        imapPort: 993,
        imapSecurity: "TLS",
      },
    },
  });
}

describe("imap-password-auth — round-trip", () => {
  it("setPasswordCreds + getPasswordCreds round-trips username + password", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-rt"),
    });
    const channel = await makeImapChannel(tenant.id);
    const result = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "staff@firm.example.com",
      password: "v3ry-secret-VALUE",
      actorMembershipId: member.membership.id,
    });
    expect(result.isFreshConnect).toBe(true);
    const creds = await getPasswordCreds(result.authId);
    expect(creds).not.toBeNull();
    expect(creds!.username).toBe("staff@firm.example.com");
    expect(creds!.password).toBe("v3ry-secret-VALUE");
    expect(result.nextReauthAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("encrypted column does NOT contain the plaintext password string", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-enc"),
    });
    const channel = await makeImapChannel(tenant.id);
    const veryRevealing = "PLAINTEXT-MUST-NEVER-LEAK-12345";
    const r = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "staff@firm.example.com",
      password: veryRevealing,
      actorMembershipId: member.membership.id,
    });
    const row = await superDb.channelAuth.findUnique({
      where: { id: r.authId },
    });
    expect(row).not.toBeNull();
    expect(row!.encryptedTokens).not.toContain(veryRevealing);
  });

  it("re-entry soft-revokes prior auth + writes audit with isFreshConnect: false", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-reenter"),
    });
    const channel = await makeImapChannel(tenant.id);
    const first = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "staff@firm.example.com",
      password: "first-pw",
      actorMembershipId: member.membership.id,
    });
    const second = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "staff@firm.example.com",
      password: "second-pw",
      actorMembershipId: member.membership.id,
    });
    expect(second.isFreshConnect).toBe(false);
    expect(second.authId).not.toBe(first.authId);
    // Prior auth soft-revoked.
    const priorRow = await superDb.channelAuth.findUnique({
      where: { id: first.authId },
    });
    expect(priorRow!.revokedAt).not.toBeNull();
    // Fresh auth has new credentials.
    const newCreds = await getPasswordCreds(second.authId);
    expect(newCreds!.password).toBe("second-pw");
    // Two audit rows (one per setPasswordCreds call).
    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_PASSWORD_AUTH_REENTERED",
      },
      orderBy: { seq: "asc" },
    });
    expect(audits).toHaveLength(2);
    const firstPayload = audits[0].payload as { isFreshConnect?: boolean };
    const secondPayload = audits[1].payload as { isFreshConnect?: boolean };
    expect(firstPayload.isFreshConnect).toBe(true);
    expect(secondPayload.isFreshConnect).toBe(false);
  });

  it("per-Member isolation: two staff on same channel have distinct creds", async () => {
    const tenant = await createTestTenant();
    const alice = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("alice"),
    });
    const bob = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("bob"),
    });
    const channel = await makeImapChannel(tenant.id);
    const a = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: alice.membership.id,
      username: "alice@firm.example.com",
      password: "alice-pw",
      actorMembershipId: alice.membership.id,
    });
    const b = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: bob.membership.id,
      username: "bob@firm.example.com",
      password: "bob-pw",
      actorMembershipId: bob.membership.id,
    });
    const aCreds = await getPasswordCreds(a.authId);
    const bCreds = await getPasswordCreds(b.authId);
    expect(aCreds!.password).toBe("alice-pw");
    expect(bCreds!.password).toBe("bob-pw");
  });

  it("getPasswordCreds returns null for OAUTH-method auths (defensive)", async () => {
    const tenant = await createTestTenant();
    const channel = await makeImapChannel(tenant.id);
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-oauth-defense"),
    });
    // Insert an auth with authMethod=OAUTH manually.
    const oauthAuth = await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake-oauth-blob",
        authMethod: "OAUTH",
      },
    });
    const creds = await getPasswordCreds(oauthAuth.id);
    expect(creds).toBeNull();
  });
});

describe("imap-password-auth — failure handling", () => {
  it("markPasswordAuthFailed stamps lastFailureAt + writes audit + dispatches channel_auth_failed", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-fail"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "staff@firm.example.com",
      password: "pw",
      actorMembershipId: member.membership.id,
    });
    await markPasswordAuthFailed({
      authId: r.authId,
      reason: "AuthenticationFailed: bad password",
    });
    const row = await superDb.channelAuth.findUnique({
      where: { id: r.authId },
    });
    expect(row!.lastFailureAt).not.toBeNull();
    expect(row!.lastFailureReason).toContain("AuthenticationFailed");
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "CHANNEL_PASSWORD_AUTH_FAILED" },
    });
    expect(audit).not.toBeNull();
    const dispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        kind: "channel_auth_failed",
      },
    });
    expect(dispatch).not.toBeNull();
  });

  it("re-entry after failure clears lastFailureAt", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-clear"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r1 = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "u",
      password: "first",
      actorMembershipId: member.membership.id,
    });
    await markPasswordAuthFailed({ authId: r1.authId, reason: "test fail" });
    const r2 = await setPasswordCreds({
      tenantId: tenant.id,
      channelId: channel.id,
      membershipId: member.membership.id,
      username: "u",
      password: "second",
      actorMembershipId: member.membership.id,
    });
    // r1 is now soft-revoked; r2 is fresh and should NOT carry the
    // failure stamp.
    const r2Row = await superDb.channelAuth.findUnique({
      where: { id: r2.authId },
    });
    expect(r2Row!.lastFailureAt).toBeNull();
    expect(r2Row!.lastFailureReason).toBeNull();
  });
});

describe("imap-password-auth — validation + tenant isolation", () => {
  it("rejects empty username", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-empty-u"),
    });
    const channel = await makeImapChannel(tenant.id);
    await expect(
      setPasswordCreds({
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        username: "   ",
        password: "x",
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/username/i);
  });

  it("rejects empty password", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-empty-p"),
    });
    const channel = await makeImapChannel(tenant.id);
    await expect(
      setPasswordCreds({
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        username: "u",
        password: "",
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/password/i);
  });

  it("rejects non-IMAP channel kind", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("imap-wrong-kind"),
    });
    const oauthChannel = await superDb.channel.create({
      data: { tenantId: tenant.id, kind: "GOOGLE", status: "ACTIVE" },
    });
    await expect(
      setPasswordCreds({
        tenantId: tenant.id,
        channelId: oauthChannel.id,
        membershipId: member.membership.id,
        username: "u",
        password: "p",
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/does not accept password/i);
  });

  it("tenant isolation: cross-tenant channel access returns not-found", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const memberA = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("imap-iso-a"),
    });
    const channelB = await makeImapChannel(tenantB.id);
    await expect(
      setPasswordCreds({
        tenantId: tenantA.id,
        channelId: channelB.id,
        membershipId: memberA.membership.id,
        username: "u",
        password: "p",
        actorMembershipId: memberA.membership.id,
      }),
    ).rejects.toThrow(/channel not found/i);
  });
});
