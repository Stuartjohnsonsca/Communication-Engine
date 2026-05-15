/**
 * Item 110 — per-User extension of `nextReauthAt`.
 *
 * Coverage:
 *   - User can extend their own `nextReauthAt` to a later date.
 *   - User CANNOT reduce — earlier than current returns ValidationError.
 *   - User CANNOT extend below tenant floor — even if their current
 *     deadline is at day 100, an extension request for `now + 30d`
 *     when tenant floor is 90 returns ValidationError.
 *   - Audit captures priorReauthAt + nextReauthAt + deltaDays.
 *   - A different Member cannot extend someone else's auth.
 *   - Auth must be PASSWORD-method (OAuth auths return not-found).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  setPasswordCreds,
  extendReauthDeadline,
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

async function makeAuth(tenantId: string, channelId: string, membershipId: string) {
  return setPasswordCreds({
    tenantId,
    channelId,
    membershipId,
    username: "u",
    password: "p",
    actorMembershipId: membershipId,
  });
}

describe("imap-reauth-extension — extension constraints", () => {
  it("User can extend their own nextReauthAt later than current", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-ok"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r = await makeAuth(tenant.id, channel.id, member.membership.id);
    const target = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const out = await extendReauthDeadline({
      authId: r.authId,
      requestedNextReauthAt: target,
      actorMembershipId: member.membership.id,
    });
    expect(out.nextReauthAt.getTime()).toBe(target.getTime());
    expect(out.deltaDays).toBeGreaterThan(0);
    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_PASSWORD_REAUTH_EXTENDED",
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as {
      priorReauthAt?: string;
      nextReauthAt?: string;
      deltaDays?: number;
    };
    expect(payload.priorReauthAt).toBeDefined();
    expect(payload.nextReauthAt).toBe(target.toISOString());
    expect(payload.deltaDays).toBeGreaterThan(0);
  });

  it("User CANNOT reduce — earlier than current returns ValidationError", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-reduce"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r = await makeAuth(tenant.id, channel.id, member.membership.id);
    const earlier = new Date(r.nextReauthAt.getTime() - 24 * 60 * 60 * 1000);
    await expect(
      extendReauthDeadline({
        authId: r.authId,
        requestedNextReauthAt: earlier,
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/never reduced/i);
  });

  it("User CANNOT extend below tenant floor (90d default)", async () => {
    const tenant = await createTestTenant();
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-floor"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r = await makeAuth(tenant.id, channel.id, member.membership.id);
    // r.nextReauthAt = now + 90d. Pick a target that's later than
    // current but only by a few days — would put the next deadline
    // still ~93 days from now, BUT requested as a relative
    // extension that's only "current + 3d" total. Wait this
    // doesn't actually violate the floor. The floor says
    // requestedNextReauthAt >= now + 90d. Current is already at
    // now+90d. So any extension is automatically >= floor.
    //
    // To trigger the floor check, need a scenario where the
    // extension is later than current BUT less than now + 90d.
    // That can only happen if current < now+90d. Set up that
    // scenario by manually nudging current to now+30d.
    await superDb.channelAuth.update({
      where: { id: r.authId },
      data: { nextReauthAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    });
    // Now request "extend" to now+60d — later than current but
    // still below tenant floor of 90.
    const target = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await expect(
      extendReauthDeadline({
        authId: r.authId,
        requestedNextReauthAt: target,
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/tenant floor/i);
  });

  it("Different Member cannot extend someone else's auth", async () => {
    const tenant = await createTestTenant();
    const owner = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-owner"),
    });
    const stranger = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-stranger"),
    });
    const channel = await makeImapChannel(tenant.id);
    const r = await makeAuth(tenant.id, channel.id, owner.membership.id);
    const target = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    await expect(
      extendReauthDeadline({
        authId: r.authId,
        requestedNextReauthAt: target,
        actorMembershipId: stranger.membership.id,
      }),
    ).rejects.toThrow(/only the auth owner/i);
  });

  it("OAuth auths cannot be extended via this endpoint (returns not-found)", async () => {
    const tenant = await createTestTenant();
    const channel = await superDb.channel.create({
      data: { tenantId: tenant.id, kind: "GOOGLE", status: "ACTIVE" },
    });
    const member = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("ext-oauth"),
    });
    const oauth = await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: member.membership.id,
        encryptedTokens: "fake",
        authMethod: "OAUTH",
      },
    });
    const target = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    await expect(
      extendReauthDeadline({
        authId: oauth.id,
        requestedNextReauthAt: target,
        actorMembershipId: member.membership.id,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
