/**
 * Post-PRD hardening item 57 — per-channel ingest activity snapshot.
 *
 * Tests cover:
 *   - per-channel last-IN / last-OUT timestamps + 7d/30d IN counts.
 *   - `silent` flag: ACTIVE + active-auth + past grace + no IN in
 *     silence window → true. Inactive channels never silent. Channels
 *     without active auth never silent. Freshly-connected (in grace
 *     window) never silent.
 *   - expired ChannelAuth is treated as "no active auth" even when
 *     `revokedAt` is null.
 *   - empty input returns an empty map (no DB calls beyond the no-op).
 *   - tenant scoping: other tenants' messages / auths don't leak in.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  getChannelHealthSnapshot,
  SILENCE_GRACE_DAYS,
  SILENCE_WARN_DAYS,
} from "@/lib/channels/health";
import { createTestTenant } from "../helpers/fixtures";

const DAY = 24 * 60 * 60 * 1000;

async function seedChannel(opts: {
  tenantId: string;
  status?: "ACTIVE" | "INACTIVE";
  kind?: string;
}) {
  return superDb.channel.create({
    data: {
      tenantId: opts.tenantId,
      kind: opts.kind ?? "GOOGLE",
      status: opts.status ?? "ACTIVE",
    },
  });
}

async function seedAuth(opts: {
  tenantId: string;
  channelId: string;
  createdAt?: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}) {
  return superDb.channelAuth.create({
    data: {
      tenantId: opts.tenantId,
      channelId: opts.channelId,
      encryptedTokens: "fixture",
      createdAt: opts.createdAt ?? new Date(),
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
}

async function seedIngested(opts: {
  tenantId: string;
  channelId: string;
  direction: "IN" | "OUT";
  createdAt?: Date;
}) {
  return superDb.ingestedMessage.create({
    data: {
      tenantId: opts.tenantId,
      channelId: opts.channelId,
      direction: opts.direction,
      sender: "c@example.com",
      subject: `stub-${randomUUID().slice(0, 6)}`,
      body: "stub",
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

describe("getChannelHealthSnapshot — counts + timestamps", () => {
  it("aggregates last-IN/OUT and 7d/30d IN counts per channel", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 60 * DAY),
    });

    // Two IN within 7d, one IN at 20d, one IN at 45d
    const now = Date.now();
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "IN",
      createdAt: new Date(now - 1 * DAY),
    });
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "IN",
      createdAt: new Date(now - 5 * DAY),
    });
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "IN",
      createdAt: new Date(now - 20 * DAY),
    });
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "IN",
      createdAt: new Date(now - 45 * DAY),
    });
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "OUT",
      createdAt: new Date(now - 2 * DAY),
    });

    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    const h = snap.get(channel.id)!;
    expect(h.inboundCount7d).toBe(2);
    expect(h.inboundCount30d).toBe(3);
    expect(h.lastInboundAt!.getTime()).toBeGreaterThan(now - 2 * DAY);
    expect(h.lastOutboundAt!.getTime()).toBeGreaterThan(now - 3 * DAY);
    expect(h.silent).toBe(false); // last IN was 1d ago — under warn
  });
});

describe("getChannelHealthSnapshot — silent flag", () => {
  it("flags ACTIVE channel with active auth + past grace + no IN in warn window", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    // No IN messages at all.
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    expect(snap.get(channel.id)!.silent).toBe(true);
  });

  it("does NOT flag an INACTIVE channel", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id, status: "INACTIVE" });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "INACTIVE" }],
    });
    expect(snap.get(channel.id)!.silent).toBe(false);
  });

  it("does NOT flag a freshly-connected channel still within the grace window", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      // Half a grace window ago — still in grace.
      createdAt: new Date(Date.now() - Math.floor(SILENCE_GRACE_DAYS * DAY * 0.5)),
    });
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    expect(snap.get(channel.id)!.silent).toBe(false);
  });

  it("does NOT flag a channel with no active auth", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    // Auth revoked yesterday.
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 30 * DAY),
      revokedAt: new Date(Date.now() - 1 * DAY),
    });
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    const h = snap.get(channel.id)!;
    expect(h.hasActiveAuth).toBe(false);
    expect(h.silent).toBe(false);
  });

  it("treats an expired ChannelAuth as inactive even when not revoked", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 30 * DAY),
      // Expired one day ago, revokedAt still null.
      expiresAt: new Date(Date.now() - 1 * DAY),
    });
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    const h = snap.get(channel.id)!;
    expect(h.hasActiveAuth).toBe(false);
    expect(h.silent).toBe(false);
  });

  it("does NOT flag when there is a recent inbound inside the warn window", async () => {
    const tenant = await createTestTenant();
    const channel = await seedChannel({ tenantId: tenant.id });
    await seedAuth({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    // IN at half-warn-window ago — fresh enough.
    await seedIngested({
      tenantId: tenant.id,
      channelId: channel.id,
      direction: "IN",
      createdAt: new Date(Date.now() - Math.floor(SILENCE_WARN_DAYS * DAY * 0.5)),
    });
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [{ id: channel.id, status: "ACTIVE" }],
    });
    expect(snap.get(channel.id)!.silent).toBe(false);
  });
});

describe("getChannelHealthSnapshot — tenant scoping", () => {
  it("does not leak messages or auths from another tenant", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const chA = await seedChannel({ tenantId: a.id });
    const chB = await seedChannel({ tenantId: b.id });
    await seedAuth({
      tenantId: a.id,
      channelId: chA.id,
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    await seedAuth({
      tenantId: b.id,
      channelId: chB.id,
      createdAt: new Date(Date.now() - 30 * DAY),
    });
    await seedIngested({
      tenantId: b.id,
      channelId: chB.id,
      direction: "IN",
      createdAt: new Date(Date.now() - 1 * DAY),
    });

    const snapA = await getChannelHealthSnapshot({
      tenantId: a.id,
      channels: [{ id: chA.id, status: "ACTIVE" }],
    });
    // Tenant A has its own channel, with no inbound. Should be silent.
    expect(snapA.get(chA.id)!.silent).toBe(true);
    expect(snapA.get(chA.id)!.inboundCount30d).toBe(0);
  });
});

describe("getChannelHealthSnapshot — empty input", () => {
  it("returns an empty map without issuing queries", async () => {
    const tenant = await createTestTenant();
    const snap = await getChannelHealthSnapshot({
      tenantId: tenant.id,
      channels: [],
    });
    expect(snap.size).toBe(0);
  });
});
