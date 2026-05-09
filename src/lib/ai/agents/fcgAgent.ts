import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/ai/client";
import { fcgSystem } from "@/lib/ai/caching";
import { MODEL_FOR } from "@/lib/ai/models";
import { fcgTools } from "@/lib/ai/tools";

export type FcgChatInput = {
  tenantId: string;
  committedFcg: unknown;
  draftFcg?: unknown;
  history: Anthropic.Messages.MessageParam[];
};

export type FcgChatOutput = {
  message: string;
  toolCalls: { name: string; input: unknown; id: string }[];
  raw: Anthropic.Messages.Message;
};

/**
 * One turn of the FCG drafting chat. The route handler calls this with
 * the rolling chat `history`, persists the assistant turn + any tool
 * calls, then if a tool call requires a server-side response (e.g.
 * `request_evidence`), composes a `tool_result` and calls again.
 */
export async function fcgChatTurn(input: FcgChatInput): Promise<FcgChatOutput> {
  const system = await fcgSystem({ committedFcg: input.committedFcg, draftFcg: input.draftFcg });
  const cfg = MODEL_FOR["fcg-chat"];
  const msg = await anthropic().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    system,
    messages: input.history,
    tools: fcgTools,
  });

  const text = msg.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  const toolCalls = msg.content
    .filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === "tool_use")
    .map((c) => ({ name: c.name, input: c.input, id: c.id }));

  return { message: text, toolCalls, raw: msg };
}
