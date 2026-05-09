import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/ai/client";
import { ucgSystem } from "@/lib/ai/caching";
import { MODEL_FOR } from "@/lib/ai/models";
import { ucgTools } from "@/lib/ai/tools";

export type UcgChatInput = {
  tenantId: string;
  fcg: unknown;
  ucg?: unknown;
  history: Anthropic.Messages.MessageParam[];
};

export type UcgChatOutput = {
  message: string;
  toolCalls: { name: string; input: unknown; id: string }[];
  raw: Anthropic.Messages.Message;
};

export async function ucgChatTurn(input: UcgChatInput): Promise<UcgChatOutput> {
  const system = await ucgSystem({ fcg: input.fcg, ucg: input.ucg });
  const cfg = MODEL_FOR["ucg-chat"];
  const msg = await anthropic().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    system,
    messages: input.history,
    tools: ucgTools,
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
