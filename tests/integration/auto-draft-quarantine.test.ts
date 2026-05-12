/**
 * Post-PRD hardening item 62 — per-inbound draft-attempt quarantine.
 *
 * Tests cover:
 *   - Single failed produceDraft → draftAttemptCount = 1, not yet
 *     quarantined; error re-thrown to the caller.
 *   - QUARANTINE_THRESHOLD consecutive failures → row is
 *     quarantined; audit event `INBOUND_DRAFT_QUARANTINED` written.
 *   - Subsequent producer call on quarantined row → `quarantined`
 *     skip code; no LLM call attempted.
 *   - Sweep candidate query EXCLUDES quarantined rows (the row is
 *     not iterated even though `drafts: { none: {} }` would still
 *     match it).
 *   - Successful first attempt never touches the quarantine columns
 *     (zero-cost for happy path).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { superDb } from "@/lib/db";

// Mock the draft agent BEFORE importing the producer so the producer
// resolves the spy when it imports `produceDraft`. The factory returns
// a function we replace per-test via `vi.mocked(...).mockImplementation`.
vi.mock("@/lib/ai/agents/draftAgent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/agents/draftAgent")>();
  return {
    ...original,
    produceDraft: vi.fn(),
  };
});

import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { produceDraftFromInbound, QUARANTINE_THRESHOLD } from "@/lib/drafts";
import { runAutoDraftSweep } from "@/lib/drafts/auto-sweep";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const mockedProduceDraft = vi.mocked(produceDraft);

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
  process.env.LLM_DEFAULT = "mock:mock";
  mockedProduceDraft.mockReset();
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

async function makeInbound(tenantId: string, channelId: string) {
  return superDb.ingestedMessage.create({
    data: {
      tenantId,
      channelId,
      direction: "IN",
      sender: `s-${randomUUID().slice(0, 6)}@example.com`,
      subject: "stub",
      body: "stub body",
    },
  });
}

describe("quarantine — per-inbound failure budget", () => {
  it("first failure bumps draftAttemptCount but does not quarantine", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await makeInbound(tenant.id, channel.id);

    mockedProduceDraft.mockRejectedValueOnce(new Error("provider 503 outage"));

    await expect(
      produceDraftFromInbound({
        tenantId: tenant.id,
        ingestedMessageId: im.id,
        membershipId: membership.id,
      }),
    ).rejects.toThrow(/provider 503 outage/);

    const after = await superDb.ingestedMessage.findUnique({
      where: { id: im.id },
      select: {
        draftAttemptCount: true,
        lastDraftAttemptAt: true,
        quarantinedFromDraftAt: true,
        quarantineReason: true,
      },
    });
    expect(after!.draftAttemptCount).toBe(1);
    expect(after!.lastDraftAttemptAt).not.toBeNull();
    expect(after!.quarantinedFromDraftAt).toBeNull();
    expect(after!.quarantineReason).toBeNull();
  });

  it("threshold reached → quarantines + audits", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await makeInbound(tenant.id, channel.id);

    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      mockedProduceDraft.mockRejectedValueOnce(new Error(`fail ${i + 1}`));
      await expect(
        produceDraftFromInbound({
          tenantId: tenant.id,
          ingestedMessageId: im.id,
          membershipId: membership.id,
        }),
      ).rejects.toThrow();
    }

    const after = await superDb.ingestedMessage.findUnique({
      where: { id: im.id },
      select: {
        draftAttemptCount: true,
        quarantinedFromDraftAt: true,
        quarantineReason: true,
      },
    });
    expect(after!.draftAttemptCount).toBe(QUARANTINE_THRESHOLD);
    expect(after!.quarantinedFromDraftAt).not.toBeNull();
    expect(after!.quarantineReason).toContain(`fail ${QUARANTINE_THRESHOLD}`);

    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "INBOUND_DRAFT_QUARANTINED",
        subjectId: im.id,
      },
    });
    expect(audits.length).toBe(1);
    const payload = audits[0]!.payload as Record<string, unknown>;
    expect(payload.attemptCount).toBe(QUARANTINE_THRESHOLD);
  });

  it("quarantined inbound returns 'quarantined' skip code without an LLM call", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "x@example.com",
        subject: "stub",
        body: "stub",
        draftAttemptCount: QUARANTINE_THRESHOLD,
        quarantinedFromDraftAt: new Date(),
        quarantineReason: "manually seeded",
      },
    });

    const r = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(r.result).toBe("skipped");
    if (r.result === "skipped") expect(r.reasonCode).toBe("quarantined");
    // Critically: the LLM was never invoked.
    expect(mockedProduceDraft).not.toHaveBeenCalled();
  });

  it("happy path: a single successful first attempt leaves quarantine columns clean", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await makeInbound(tenant.id, channel.id);

    mockedProduceDraft.mockResolvedValueOnce({
      type: "holding",
      channel: "email",
      language: "en",
      subject: "Acknowledged",
      body: "Thanks — back in 24h.",
      citations: [],
      holdingRequired: false,
      noGoSubjectHit: false,
      researchTaskRequired: false,
      actions: [],
    } as unknown as Awaited<ReturnType<typeof produceDraft>>);

    const r = await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });
    expect(r.result).toBe("produced");

    const after = await superDb.ingestedMessage.findUnique({
      where: { id: im.id },
      select: {
        draftAttemptCount: true,
        lastDraftAttemptAt: true,
        quarantinedFromDraftAt: true,
      },
    });
    expect(after!.draftAttemptCount).toBe(0);
    expect(after!.lastDraftAttemptAt).toBeNull();
    expect(after!.quarantinedFromDraftAt).toBeNull();
  });
});

describe("quarantine — sweep integration", () => {
  it("auto-sweep candidate query excludes quarantined rows", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    // Two inbound — one healthy, one quarantined.
    const imHealthy = await makeInbound(tenant.id, channel.id);
    await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "bad@example.com",
        subject: "bad",
        body: "bad",
        draftAttemptCount: QUARANTINE_THRESHOLD,
        quarantinedFromDraftAt: new Date(),
        quarantineReason: "previously failed",
      },
    });

    mockedProduceDraft.mockResolvedValue({
      type: "holding",
      channel: "email",
      language: "en",
      subject: "Acknowledged",
      body: "Thanks.",
      citations: [],
      holdingRequired: false,
      noGoSubjectHit: false,
      researchTaskRequired: false,
      actions: [],
    } as unknown as Awaited<ReturnType<typeof produceDraft>>);

    const result = await runAutoDraftSweep({ tenantId: tenant.id });
    expect(result.candidates).toBe(1);
    expect(result.produced).toBe(1);
    expect(result.errored).toBe(0);

    const draftCount = await superDb.draft.count({
      where: { tenantId: tenant.id, ingestedMessageId: imHealthy.id },
    });
    expect(draftCount).toBe(1);
  });

  it("operator unquarantine resets the counter so retry gets a fresh budget", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "y@example.com",
        subject: "stub",
        body: "stub",
        draftAttemptCount: QUARANTINE_THRESHOLD,
        quarantinedFromDraftAt: new Date(),
        quarantineReason: "old failure",
      },
    });

    // Simulate the API route's effect.
    await superDb.ingestedMessage.update({
      where: { id: im.id },
      data: {
        quarantinedFromDraftAt: null,
        quarantineReason: null,
        draftAttemptCount: 0,
        lastDraftAttemptAt: null,
      },
    });

    // Retry fails once — count goes to 1, NOT immediately re-quarantined.
    // If unquarantine had left the count at threshold, the very next
    // failure would put it at threshold+1 and re-trip the quarantine.
    mockedProduceDraft.mockRejectedValueOnce(new Error("transient"));
    await expect(
      produceDraftFromInbound({
        tenantId: tenant.id,
        ingestedMessageId: im.id,
        membershipId: membership.id,
      }),
    ).rejects.toThrow();

    const after = await superDb.ingestedMessage.findUnique({
      where: { id: im.id },
      select: { draftAttemptCount: true, quarantinedFromDraftAt: true },
    });
    expect(after!.draftAttemptCount).toBe(1);
    expect(after!.quarantinedFromDraftAt).toBeNull();
  });
});
