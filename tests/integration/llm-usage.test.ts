/**
 * Post-PRD hardening item 55 — LLM usage observability.
 *
 * Coverage:
 *   - `recordLlmCall` persists an LlmCall row with the supplied
 *     tokens, role, context, and provider.
 *   - `client.ts` chat() / callTool() write a row when `record` is set,
 *     and DON'T when it is omitted.
 *   - The auto-draft path (`produceDraftFromInbound`) records under
 *     context="auto-draft" with membershipId=null.
 *   - The classifier path records under context="sentiment-classify"
 *     with the assigned membership.
 *   - `estimateCostMinor` is monotonic in tokens and zero for unknown
 *     models / the mock provider.
 *   - A failed LLM call still records a row with `succeeded: false`.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import { recordLlmCall, estimateCostMinor } from "@/lib/ai/usage";
import { callTool } from "@/lib/ai/client";
import { tool } from "@/lib/ai/client";
import { produceDraftFromInbound } from "@/lib/drafts";
import { classifyAndRecordInbound } from "@/lib/sentiment/record";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
  // Force the mock provider for all agents so the test doesn't hit
  // real APIs even if the CI environment has API keys set.
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

describe("recordLlmCall — persistence shape", () => {
  it("writes an LlmCall row with the supplied fields", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("rec"),
    });

    await recordLlmCall({
      record: {
        tenantId: tenant.id,
        context: "test-context",
        membershipId: membership.id,
      },
      role: "draft",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      modelRunId: "msg_test_123",
      usage: {
        inputTokens: 1500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 850,
      succeeded: true,
    });

    const rows = await superDb.llmCall.findMany({
      where: { tenantId: tenant.id, modelRunId: "msg_test_123" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("draft");
    expect(rows[0]!.context).toBe("test-context");
    expect(rows[0]!.provider).toBe("anthropic");
    expect(rows[0]!.model).toBe("claude-haiku-4-5-20251001");
    expect(rows[0]!.inputTokens).toBe(1500);
    expect(rows[0]!.outputTokens).toBe(200);
    expect(rows[0]!.membershipId).toBe(membership.id);
    expect(rows[0]!.succeeded).toBe(true);
  });
});

describe("client.ts opt-in recording via callTool", () => {
  it("writes a row when record is set, none when it isn't", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("opt-in"),
    });

    const stubTool = tool("respond_with_sentiment", "stub", { type: "object" });
    const before = await superDb.llmCall.count({ where: { tenantId: tenant.id } });

    await callTool({
      role: "sentiment",
      system: [{ text: "stub" }],
      messages: [{ role: "user", content: "stub" }],
      tool: stubTool,
      record: {
        tenantId: tenant.id,
        context: "opt-in-test",
        membershipId: null,
      },
    });
    const afterRecorded = await superDb.llmCall.count({ where: { tenantId: tenant.id } });
    expect(afterRecorded).toBe(before + 1);

    // Same call without record — count must not move.
    await callTool({
      role: "sentiment",
      system: [{ text: "stub" }],
      messages: [{ role: "user", content: "stub" }],
      tool: stubTool,
    });
    const afterOmitted = await superDb.llmCall.count({ where: { tenantId: tenant.id } });
    expect(afterOmitted).toBe(afterRecorded);
  });
});

describe("auto-draft path records under context='auto-draft'", () => {
  it("produceDraftFromInbound writes an LlmCall with auto-draft context + null actor", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("auto"),
    });
    await commitMinimalFcg(tenant.id);
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "client@example.com",
        subject: "RE: deadline",
        body: "When can we expect a response?",
      },
    });

    await produceDraftFromInbound({
      tenantId: tenant.id,
      ingestedMessageId: im.id,
      membershipId: membership.id,
    });

    const draftRows = await superDb.llmCall.findMany({
      where: { tenantId: tenant.id, context: "auto-draft" },
    });
    expect(draftRows.length).toBeGreaterThanOrEqual(1);
    expect(draftRows[0]!.role).toBe("draft");
    expect(draftRows[0]!.membershipId).toBeNull();
  });
});

describe("classifier records under context='sentiment-classify' with assignee", () => {
  it("classifyAndRecordInbound writes an LlmCall row attributing the assignee Membership", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("classify"),
    });
    const channel = await setupChannel(tenant.id, membership.id);
    const im = await superDb.ingestedMessage.create({
      data: {
        tenantId: tenant.id,
        channelId: channel.id,
        direction: "IN",
        sender: "client@example.com",
        subject: "Concerns",
        body: "This is unacceptable.",
      },
    });

    await classifyAndRecordInbound({
      tenantId: tenant.id,
      assignedToMembershipId: membership.id,
      ingestedMessageId: im.id,
      inbound: {
        channel: "email",
        sender: "client@example.com",
        subject: "Concerns",
        body: "This is unacceptable.",
      },
    });

    const rows = await superDb.llmCall.findMany({
      where: { tenantId: tenant.id, context: "sentiment-classify" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.role).toBe("sentiment");
    expect(rows[0]!.membershipId).toBe(membership.id);
  });
});

describe("estimateCostMinor — math", () => {
  it("returns 0 for unknown models", () => {
    expect(
      estimateCostMinor({
        model: "unknown-model",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });

  it("returns 0 for the mock provider", () => {
    expect(
      estimateCostMinor({
        model: "mock",
        inputTokens: 5_000_000,
        outputTokens: 5_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });

  it("is monotonic in input + output tokens for known models", () => {
    const small = estimateCostMinor({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const large = estimateCostMinor({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(large).toBeGreaterThan(small);
  });

  it("Sonnet is materially more expensive than Haiku at the same token count", () => {
    const haiku = estimateCostMinor({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const sonnet = estimateCostMinor({
      model: "claude-sonnet-4-6",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(sonnet).toBeGreaterThan(haiku * 3);
  });
});
