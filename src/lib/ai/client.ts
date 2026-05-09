import { bindingFor } from "@/lib/ai/models";
import { effectiveProvider } from "@/lib/ai/providers";
import type {
  AgentRole,
  CallToolOpts,
  ChatOpts,
  ChatResult,
  ToolDef,
  ToolResult,
  SystemBlock,
} from "@/lib/ai/providers/types";

/**
 * Top-level entry points. `chat()` is for open-ended turns with optional
 * tool calls (FCG/UCG drafting). `callTool()` is for forced single-tool
 * structured outputs (Judge, drafting final, sentiment, etc.).
 *
 * Each call dispatches to the provider bound to the agent role.
 */

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const binding = bindingFor(opts.role);
  const provider = effectiveProvider(binding.provider);
  return provider.chat({
    ...opts,
    model: opts.model ?? binding.model,
    maxTokens: opts.maxTokens ?? binding.maxTokens,
    temperature: opts.temperature ?? binding.temperature,
  });
}

export async function callTool<T>(opts: CallToolOpts): Promise<ToolResult<T>> {
  const binding = bindingFor(opts.role);
  const provider = effectiveProvider(binding.provider);
  return provider.callTool<T>({
    ...opts,
    model: opts.model ?? binding.model,
    maxTokens: opts.maxTokens ?? binding.maxTokens,
    temperature: opts.temperature ?? binding.temperature,
  });
}

/** Helper for agents to declare a tool with a JSON-Schema input. */
export function tool(name: string, description: string, schema: Record<string, unknown>): ToolDef {
  return { name, description, schema };
}

/**
 * Build a layered system message. `cache: true` blocks are cached on
 * Anthropic with 1h TTL; non-Anthropic providers ignore the hint.
 */
export function buildSystem(blocks: { text: string; cache?: boolean }[]): SystemBlock[] {
  return blocks.map((b) => ({ text: b.text, cache: b.cache }));
}

/** Re-exports for convenience. */
export type { AgentRole, ChatOpts, CallToolOpts, ChatResult, ToolResult, SystemBlock, ToolDef };
