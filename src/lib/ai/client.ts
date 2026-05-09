import Anthropic from "@anthropic-ai/sdk";
import { MODEL_FOR, type AgentRole } from "@/lib/ai/models";

declare global {
  // eslint-disable-next-line no-var
  var __anthropic: Anthropic | undefined;
}

/**
 * Singleton Anthropic client.
 *
 * Headers:
 *  - `extended-cache-ttl-2025-04-11` enables 1h ephemeral prompt cache TTL
 *    instead of the 5-min default. Required for the FCG/UCG hot path
 *    where a single user produces many drafts in a session against a
 *    stable FCG+UCG context.
 *
 * TODO (PRD §12.6): pin to an in-region (UK/EU) endpoint and assert
 * no-training/no-retention flags before any tenant goes live.
 */
function makeClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  return new Anthropic({
    apiKey,
    defaultHeaders: {
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
    },
  });
}

export function anthropic(): Anthropic {
  if (!global.__anthropic) global.__anthropic = makeClient();
  return global.__anthropic;
}

export type CachedSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

/**
 * Build a system message as an array of blocks ordered most-stable to
 * least-stable. Mark the boundary of every stable region with
 * `cache_control: { type: 'ephemeral', ttl: '1h' }`.
 *
 * Anthropic caches the *prefix* up to and including the marked block,
 * so caching the FCG block automatically caches the static system prompt
 * block before it.
 */
export function buildCachedSystem(blocks: { text: string; cache?: boolean }[]): CachedSystemBlock[] {
  return blocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
  }));
}

/**
 * Force-tool-call helper. The model is required to invoke `tool.name` exactly
 * once and stop; the tool's `input` is parsed as the structured response.
 */
export async function callTool<T>(opts: {
  role: AgentRole;
  system: CachedSystemBlock[];
  messages: Anthropic.Messages.MessageParam[];
  tool: Anthropic.Messages.Tool;
  tenantId?: string;
}): Promise<{ output: T; raw: Anthropic.Messages.Message }> {
  const cfg = MODEL_FOR[opts.role];
  const msg = await anthropic().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    system: opts.system,
    messages: opts.messages,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
  });
  const block = msg.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use" || block.name !== opts.tool.name) {
    throw new Error(`callTool: model did not invoke ${opts.tool.name}`);
  }
  return { output: block.input as T, raw: msg };
}
