import { bindingFor } from "@/lib/ai/models";
import { effectiveProvider, PROVIDER_DEFAULT_MODEL } from "@/lib/ai/providers";
import { recordLlmCall } from "@/lib/ai/usage";
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
 *
 * Item 55 — when `opts.record` is set, the call writes one `LlmCall`
 * row capturing tokens + wall-clock duration + outcome to the tenant's
 * scoped table. Errors in persistence are swallowed (logged via
 * `reportError`); the LLM call result still returns to the caller.
 */

/** Resolve binding → effective provider, swapping the model when the
 *  effective provider differs (e.g. Anthropic role falling back to Together
 *  because no ANTHROPIC_API_KEY is set). */
function resolve(role: AgentRole, override?: { model?: string; maxTokens?: number; temperature?: number }) {
  const binding = bindingFor(role);
  const provider = effectiveProvider(binding.provider);
  const fellBack = provider.name !== binding.provider;
  const model = override?.model ?? (fellBack ? PROVIDER_DEFAULT_MODEL[provider.name] ?? binding.model : binding.model);
  return {
    provider,
    model,
    maxTokens: override?.maxTokens ?? binding.maxTokens,
    temperature: override?.temperature ?? binding.temperature,
  };
}

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const r = resolve(opts.role, opts);
  const startedAt = Date.now();
  try {
    const result = await r.provider.chat({
      ...opts,
      model: r.model,
      maxTokens: r.maxTokens,
      temperature: r.temperature,
    });
    if (opts.record) {
      await recordLlmCall({
        record: opts.record,
        role: opts.role,
        provider: r.provider.name,
        model: r.model,
        modelRunId: result.modelRunId,
        usage: result.usage,
        durationMs: Date.now() - startedAt,
        succeeded: true,
      });
    }
    return result;
  } catch (err) {
    if (opts.record) {
      await recordLlmCall({
        record: opts.record,
        role: opts.role,
        provider: r.provider.name,
        model: r.model,
        durationMs: Date.now() - startedAt,
        succeeded: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

export async function callTool<T>(opts: CallToolOpts): Promise<ToolResult<T>> {
  const r = resolve(opts.role, opts);
  const startedAt = Date.now();
  try {
    const result = await r.provider.callTool<T>({
      ...opts,
      model: r.model,
      maxTokens: r.maxTokens,
      temperature: r.temperature,
    });
    if (opts.record) {
      await recordLlmCall({
        record: opts.record,
        role: opts.role,
        provider: r.provider.name,
        model: r.model,
        modelRunId: result.modelRunId,
        usage: result.usage,
        durationMs: Date.now() - startedAt,
        succeeded: true,
      });
    }
    return result;
  } catch (err) {
    if (opts.record) {
      await recordLlmCall({
        record: opts.record,
        role: opts.role,
        provider: r.provider.name,
        model: r.model,
        durationMs: Date.now() - startedAt,
        succeeded: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
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
