/**
 * Post-PRD hardening item 53 — channel-auth expiry warning.
 *
 * Coverage:
 *   - 7-day threshold fires a dispatch + CHANNEL_AUTH_EXPIRY_WARNED audit
 *     for an ACTIVE ChannelAuth whose expiresAt falls inside the window.
 *   - 1-day threshold fires a SECOND, distinct dispatch (different
 *     dedupeKey) when the token gets closer to expiry. Both warnings
 *     coexist across the same token's lifetime.
 *   - Idempotent: running the sweep twice on the same day with the same
 *     token produces no additional dispatches.
 *   - Skip conditions: revoked, missing expiresAt, already-expired,
 *     orphan auth (no membership), non-ACTIVE membership.
 *   - Notification kind is mandatory (not opt-outable) — a preference
 *     row trying to mute it has no effect.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { runChannelAuthExpiryCheck } from "@/lib/channels/expiry-check";
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

async function setupExpiringChannel(opts: {
  tenantId: string;
  membershipId: string;
  expiresAt: Date | null;
  revokedAt?: Date | null;
}) {
  const channel = await superDb.channel.create({
    data: { tenantId: opts.tenantId, kind: "GOOGLE", status: "ACTIVE" },
  });
  const auth = await superDb.channelAuth.create({
    data: {
      tenantId: opts.tenantId,
      channelId: channel.id,
      membershipId: opts.membershipId,
      encryptedTokens: "fixture",
      expiresAt: opts.expiresAt,
      revokedAt: opts.revokedAt ?? null,
    },
  });
  return { channel, auth };
}

describe("channel-auth expiry warning — threshold firing", () => {
  it("fires a 7d warning + audit when expiresAt is 5 days out", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("owner-7d"),
    });
    const { auth } = await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.warned).toBe(1);
    expect(r.warnedByThreshold["7d"]).toBe(1);
    expect(r.warnedByThreshold["1d"]).toBe(0);

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "channel_auth_expiring",
        dedupeKey: `${auth.id}:7d`,
      },
    });
    expect(dispatch).toBeTruthy();

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_AUTH_EXPIRY_WARNED",
        subjectId: auth.id,
      },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as { threshold: string; daysUntilExpiry: number };
    expect(payload.threshold).toBe("7d");
    expect(payload.daysUntilExpiry).toBeGreaterThanOrEqual(4);
    expect(payload.daysUntilExpiry).toBeLessThanOrEqual(5);
  });

  it("fires a separate 1d warning after the 7d warning has already fired", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("owner-1d"),
    });
    const { auth } = await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });

    // First pass: 7d warning fires.
    const first = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(first.warnedByThreshold["7d"]).toBe(1);

    // Move expiry into the 1d window — simulate the passage of time
    // by updating expiresAt rather than mocking the clock.
    await superDb.channelAuth.update({
      where: { id: auth.id },
      data: { expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000) },
    });

    const second = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(second.warnedByThreshold["1d"]).toBe(1);
    expect(second.warnedByThreshold["7d"]).toBe(0);

    const dispatches = await superDb.notificationDispatch.findMany({
      where: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "channel_auth_expiring",
      },
      orderBy: { sentAt: "asc" },
    });
    expect(dispatches.length).toBe(2);
    expect(dispatches.map((d) => d.dedupeKey).sort()).toEqual(
      [`${auth.id}:1d`, `${auth.id}:7d`].sort(),
    );
  });

  it("is idempotent within a threshold: second sweep produces no new dispatch", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("owner-idem"),
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const first = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(first.warned).toBe(1);

    const second = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(second.warned).toBe(0);
    expect(second.alreadyWarned).toBe(1);

    const dispatches = await superDb.notificationDispatch.count({
      where: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "channel_auth_expiring",
      },
    });
    expect(dispatches).toBe(1);
  });
});

describe("channel-auth expiry warning — skip conditions", () => {
  it("skips revoked auths", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("revoked"),
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      revokedAt: new Date(),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips auths with no expiresAt", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("noExpiry"),
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: null,
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips already-expired auths (too late to warn)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("expired"),
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips auths far outside the 7d horizon", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("far"),
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(0);
    expect(r.warned).toBe(0);
  });

  it("skips orphan auths (membershipId null)", async () => {
    const tenant = await createTestTenant();
    const channel = await superDb.channel.create({
      data: { tenantId: tenant.id, kind: "GOOGLE", status: "ACTIVE" },
    });
    await superDb.channelAuth.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        membershipId: null,
        encryptedTokens: "fixture",
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.warned).toBe(0);
  });

  it("skips when the owning Membership is no longer ACTIVE (suspended / anonymised)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("suspended"),
    });
    await superDb.membership.update({
      where: { id: membership.id },
      data: { status: "SUSPENDED" },
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.warned).toBe(0);
  });
});

describe("channel-auth expiry warning — mandatory kind (item 45 interaction)", () => {
  it("a mute preference for channel_auth_expiring has no effect — the email still dispatches", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("mute"),
    });
    // Insert a mute preference directly (the public API would refuse —
    // ValidationError on a mandatory kind — but defence in depth means
    // the dispatcher must ignore a poked-in row too).
    await superDb.membershipNotificationPreference.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "channel_auth_expiring",
        emailEnabled: false,
      },
    });
    await setupExpiringChannel({
      tenantId: tenant.id,
      membershipId: membership.id,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const r = await runChannelAuthExpiryCheck({ tenantId: tenant.id });
    expect(r.warned).toBe(1);

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: {
        tenantId: tenant.id,
        membershipId: membership.id,
        kind: "channel_auth_expiring",
      },
    });
    expect(dispatch).toBeTruthy();
    // The dispatcher should NOT have honoured the mute row — status is
    // either DISPATCHED (mailer configured) or SKIPPED_NO_EMAIL_SERVER
    // (typical CI), never SKIPPED_USER_PREFERENCE.
    expect(dispatch!.status).not.toBe("SKIPPED_USER_PREFERENCE");
  });
});
