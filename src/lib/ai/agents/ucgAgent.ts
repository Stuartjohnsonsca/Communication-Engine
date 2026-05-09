import { chat } from "@/lib/ai/client";
import { ucgSystem } from "@/lib/ai/caching";
import { ucgTools } from "@/lib/ai/tools";
import type { ChatMessage, ToolCall } from "@/lib/ai/providers/types";

export type UcgChatInput = {
  tenantId: string;
  fcg: unknown;
  ucg?: unknown;
  history: ChatMessage[];
};

export type UcgChatOutput = {
  message: string;
  toolCalls: ToolCall[];
};

export async function ucgChatTurn(input: UcgChatInput): Promise<UcgChatOutput> {
  const system = await ucgSystem({ fcg: input.fcg, ucg: input.ucg });
  const r = await chat({
    role: "ucg-chat",
    system,
    messages: input.history,
    tools: ucgTools,
  });
  return { message: r.message, toolCalls: r.toolCalls };
}
