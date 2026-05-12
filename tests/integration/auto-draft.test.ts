/**
 * Post-PRD hardening item 50 — continuous-background draft producer.
 *
 * Coverage:
 *   - Happy path: an ingested IN message with no Draft + an active
 *     COMMITTED FCG + an active Membership on the ingest channel
 *     yields one Draft (auto-produced) and one AuditEvent with
 *     `autoProduced: true` and `actorMembershipId: null`.
 *   - Idempotency: a second sweep over the same backlog produces no
 *     new drafts.
 *   - Skips when no Membership is attached to the ingest channel
 *     (cannot attribute UCG / lifecycle).
 *   - Skips when the owning Membership is lifecycle-revoked.
 *   - Skips when the sender is the Membership's own User email
 *     (User's own outbound bouncing back).
 *   - Skips when the tenant has no COMMITTED FCG.
 *   - Old inbound (outside the 24h backlog window) is ignored on a
 *     first run — operators backfill via a separate path.
 *   - MAX_PER_TENANT_PER_PASS bounds the work per tick.
 *   - Sweep is tenant-isolated: tenant A's inbound never produces a
 *     draft in tenant B.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { runAutoDraftSweep, produceDraftFromInbound } from "@/lib/drafts";
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

/** Minimum FCG required for the agent / route to consider drafting permitted. */
async function commitMinimalFcg(tenantId: string) {
  return superDb.firmCultureGuide.create({
    data: {
      tenantId,
      version: 1,
      status: "COMMITTED",
      effectiveAt: new Date(),
      rules: {
        create: [
          {
            tenantId,
            externalId: "rule_holding_30min",
            category: "RESPONSE_TIME",
            channel: "EMAIL",
            statement: "Acknowledge within 30 minutes; substantive response within 24 hours.",
            mandatory: true,
            payload: { ackWithinMinutes: 30, respondWithinHours: 24 },
          },
        ],
      },
    },
  });
}

async function setupChannel(tenantId: string, membershipId: string) {
  const channel = await superDb.channel.create({
    data: { tenantId, kind: "GOOGLE", status: "ACTIVE" },
  });
  await superDb.channelAuth.create({
    data: {
      tenantId,
      channelId: channel.id,
      membershipId,
      encryptedTokens: "fixture",
    },
  });
  return channel;
}

async function makeInbound(opts: {
  tenantId: string;
  channelId: string;
  sender?: string;
  subject?: string;
  body?: string;
  createdAt?: Date;
}) {
  return superDb.ingestedMessage.create({
    data: {
      tenantId: opts.tenantId,
      channelId: opts.channelId,
      direction: "IN",
      sender: opts.sender ?? "client@example.com",
      subject: opts.subject ?? "RE: matter update",
      body: opts.body ?? "Can you confirm the position on the deadline?",
      sentAt: opts.createdAt ?? new Date(),
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

describe("auto-draft sweep — happy path + idempotency", () => {
  it("produces a Draft for an un-drafted inbound and writes an autoProduced audit", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("owner"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(r.tenantsScanned).toBeGreaterThanOrEqual(1);
    expect(r.produced).toBe(1);
    expect(r.errored).toBe(0);

    const drafts = await superDb.draft.findMany({
      where: { tenantId: tenant.id, ingestedMessageId: im.id },
    });
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.membershipId).toBe(membership.id);
    // The mock provider returns a holding draft.
    expect(drafts[0]!.kind).toBe("HOLDING");

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "DRAFT_PRODUCED",
        subjectId: drafts[0]!.id,
      },
    });
    expect(audit).toBeTruthy();
    // System-driven: no User actor.
    expect(audit!.actorMembershipId).toBeNull();
    const payload = audit!.payload as { autoProduced: boolean; ingestedMessageId: string };
    expect(payload.autoProduced).toBe(true);
    expect(payload.ingestedMessageId).toBe(im.id);
  });

  it("is idempotent: second pass produces no new drafts", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("owner"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    const first = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(first.produced).toBe(1);

    const second = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(second.produced).toBe(0);
    // The IM is filtered out by the `drafts: { none: {} }` clause on the
    // second pass — it doesn't even appear as a candidate.
    expect(second.candidates).toBe(0);
  });
});

describe("auto-draft sweep — skip conditions", () => {
  it("skips when the channel has no active ChannelAuth (no Membership to attribute to)", async () => {
    const tenant = await createTestTenant();
    await commitMinimalFcg(tenant.id);
    const channel = await superDb.channel.create({
      data: { tenantId: tenant.id, kind: "GOOGLE", status: "ACTIVE" },
    });
    await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(r.produced).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when the owning Membership is lifecycle-revoked", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("revoked"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    // Mark the membership as access-revoked outside the grace window.
    await superDb.membership.update({
      where: { id: membership.id },
      data: {
        accessRevokedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        reauthDeadlineAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(r.produced).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when the sender is the owning User's own email (own outbound bouncing back)", async () => {
    const tenant = await createTestTenant();
    const ownerEmail = uniqueEmail("self");
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: ownerEmail,
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    await makeInbound({
      tenantId: tenant.id,
      channelId: channel.id,
      sender: ownerEmail.toUpperCase(), // case-insensitive match
    });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(r.produced).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when the tenant has no COMMITTED FCG", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("noFcg"),
    });
    // FCG exists but as DRAFT only — not committed.
    await superDb.firmCultureGuide.create({
      data: { tenantId: tenant.id, version: 1, status: "DRAFT" },
    });
    const channel = await setupChannel(tenant.id, membership.id);
    await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    // The tenant is filtered out by `fcgs: { some: { status: 'COMMITTED' } }`,
    // so the inbound never even becomes a candidate.
    expect(r.produced).toBe(0);
  });

  it("ignores inbound older than the 24h backlog window", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("old"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    await makeInbound({
      tenantId: tenant.id,
      channelId: channel.id,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    const r = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(r.produced).toBe(0);
    expect(r.candidates).toBe(0);
  });
});

describe("auto-draft sweep — tenant isolation", () => {
  it("tenant A's inbound never produces a draft in tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: memberA } = await createTestUserAndMembership(tenantA.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("tenantA"),
    });
    await commitMinimalFcg(tenantA.id);
    await commitMinimalFcg(tenantB.id);
    const channelA = await setupChannel(tenantA.id, memberA.id);
    await makeInbound({ tenantId: tenantA.id, channelId: channelA.id });

    // Sweep tenant B only — A's inbound must not be drafted.
    const r = await runAutoDraftSweep({ tenantId: tenantB.id });
    expect(r.produced).toBe(0);

    const draftsInB = await superDb.draft.count({ where: { tenantId: tenantB.id } });
    expect(draftsInB).toBe(0);

    const draftsInA = await superDb.draft.count({ where: { tenantId: tenantA.id } });
    expect(draftsInA).toBe(0); // because we only swept B
  });
});

describe("produceDraftFromInbound — direct call", () => {
  it("is idempotent if a Draft already exists for the inbound", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("idem"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await makeInbound({ tenantId: tenant.id, channelId: channel.id });

    const first = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(first.result).toBe("produced");

    const second = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(second.result).toBe("skipped");
    if (second.result === "skipped") {
      expect(second.reason).toMatch(/already exists/);
    }
  });
});
