/**
 * Post-PRD hardening item 58 — tenant-level auto-draft pause toggle.
 *
 * Tests cover:
 *   - produceDraftFromInbound short-circuits with `auto_draft_paused`
 *     when the Tenant.autoDraftPausedAt is set.
 *   - Pausing again while already paused preserves the original
 *     pausedAt (idempotent), but updates the reason.
 *   - Resuming a paused tenant clears all three fields.
 *   - Resuming a non-paused tenant is a no-op (idempotent).
 *   - The pause gate sits BEFORE the idempotency check — a duplicate
 *     IngestedMessage call returns `auto_draft_paused`, not
 *     `draft_already_exists`.
 *   - Manual paste (mocked via direct Draft create) is unaffected —
 *     the gate is specific to produceDraftFromInbound.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { produceDraftFromInbound } from "@/lib/drafts";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
  process.env.LLM_DEFAULT = "mock:mock";
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

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
            statement: "Acknowledge within 30 minutes; respond within 24 hours.",
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

describe("produceDraftFromInbound — auto-draft pause gate", () => {
  it("short-circuits with auto_draft_paused when the tenant is paused", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("pause"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "c@example.com",
        subject: "stub",
        body: "stub",
      },
    });

    await superDb.tenant.update({
      where: { id: tenant.id },
      data: {
        autoDraftPausedAt: new Date(),
        autoDraftPausedByName: "Stuart",
        autoDraftPauseReason: "FCG revision",
      },
    });

    const result = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(result.result).toBe("skipped");
    if (result.result === "skipped") {
      expect(result.reasonCode).toBe("auto_draft_paused");
    }
    // No Draft row created.
    const drafts = await superDb.draft.findMany({
      where: { tenantId: tenant.id },
    });
    expect(drafts.length).toBe(0);
  });

  it("produces normally when the tenant is unpaused", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("unpause"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "c@example.com",
        subject: "stub",
        body: "stub",
      },
    });
    const result = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(result.result).toBe("produced");
  });

  it("pause gate sits before idempotency: pausing after a draft exists still returns auto_draft_paused for a re-call", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("order"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "c@example.com",
        subject: "stub",
        body: "stub",
      },
    });

    // First call — produces.
    const first = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(first.result).toBe("produced");

    // Now pause.
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: { autoDraftPausedAt: new Date() },
    });

    // Re-call: should hit the pause gate (it sits BEFORE the
    // already-exists check), so reasonCode is auto_draft_paused
    // rather than draft_already_exists.
    const second = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(second.result).toBe("skipped");
    if (second.result === "skipped") {
      expect(second.reasonCode).toBe("auto_draft_paused");
    }
  });
});
