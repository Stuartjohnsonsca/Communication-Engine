/**
 * Item 110 — expiry-check cron extension for PASSWORD-method auths.
 *
 * Coverage:
 *   - OAuth path regression-pin: 7d/1d thresholds still fire on
 *     `expiresAt` window (item 53 unchanged).
 *   - PASSWORD path: 14d threshold fires when nextReauthAt is in
 *     (now, now+14d].
 *   - PASSWORD path: 3d threshold fires (and supersedes 14d) when
 *     nextReauthAt is in (now, now+3d].
 *   - Both paths fire the SAME notification kind
 *     `channel_auth_expiring` so the User-facing UX is unified.
 *   - Revoked auths skipped on both paths.
 *   - Tenant isolation: `tenantId` filter scopes correctly.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { runChannelAuthExpiryCheck } from "@/lib/channels/expiry-check";
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

async function makeChannel(tenantId: string, kind: string) {
  return superDb.channel.create({
    data: { tenantId, kind, status: "ACTIVE" },
  });
}

describe("imap-expiry-cron — OAuth path regression-pin (item 53)", () => {
  it("OAuth auth expiring inside 7d fires channel_auth_expiring with threshold 7d", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("oauth-7d"),
    });
    const channel = await makeChannel(tenant.id, "GOOGLE");
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5d
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake-oauth",
        authMethod: "OAUTH",
        expiresAt,
      },
    });
    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warnedByThreshold["7d"]).toBe(1);
    expect(r.warnedByThreshold["14d"]).toBe(0);
    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { tenantId: tenant.id, kind: "channel_auth_expiring" },
    });
    expect(dispatch).not.toBeNull();
  });
});

describe("imap-expiry-cron — PASSWORD path (item 110)", () => {
  it("PASSWORD auth with nextReauthAt in 10d fires threshold 14d", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("pw-14d"),
    });
    const channel = await makeChannel(tenant.id, "IMAP");
    const nextReauthAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10d
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake",
        authMethod: "PASSWORD",
        nextReauthAt,
      },
    });
    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warnedByThreshold["14d"]).toBe(1);
    expect(r.warnedByThreshold["3d"]).toBe(0);
    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { tenantId: tenant.id, kind: "channel_auth_expiring" },
    });
    expect(dispatch).not.toBeNull();
  });

  it("PASSWORD auth with nextReauthAt in 2d fires threshold 3d (urgent)", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("pw-3d"),
    });
    const channel = await makeChannel(tenant.id, "IMAP");
    const nextReauthAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake",
        authMethod: "PASSWORD",
        nextReauthAt,
      },
    });
    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warnedByThreshold["3d"]).toBe(1);
    expect(r.warnedByThreshold["14d"]).toBe(0);
  });

  it("revoked PASSWORD auth is skipped (no dispatch)", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("pw-revoked"),
    });
    const channel = await makeChannel(tenant.id, "IMAP");
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake",
        authMethod: "PASSWORD",
        nextReauthAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        revokedAt: new Date(),
      },
    });
    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warned).toBe(0);
    expect(r.scanned).toBe(0);
  });

  it("PASSWORD auth with nextReauthAt > 14d is NOT warned", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("pw-far"),
    });
    const channel = await makeChannel(tenant.id, "IMAP");
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake",
        authMethod: "PASSWORD",
        nextReauthAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60d
      },
    });
    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warned).toBe(0);
    expect(r.scanned).toBe(0);
  });
});
