import { chat } from "@/lib/ai/client";
import { fcgSystem } from "@/lib/ai/caching";
import { fcgTools } from "@/lib/ai/tools";
import type { ChatMessage, ToolCall } from "@/lib/ai/providers/types";

export type FcgChatInput = {
  tenantId: string;
  committedFcg: unknown;
  draftFcg?: unknown;
  history: ChatMessage[];
};

export type FcgChatOutput = {
  message: string;
  toolCalls: ToolCall[];
};

/** One turn of the FCG drafting chat. Provider chosen per the LLM_FCG_CHAT env binding. */
export async function fcgChatTurn(input: FcgChatInput): Promise<FcgChatOutput> {
  const system = await fcgSystem({ committedFcg: input.committedFcg, draftFcg: input.draftFcg });
  const r = await chat({
    role: "fcg-chat",
    system,
    messages: input.history,
    tools: fcgTools,
  });
  return { message: r.message, toolCalls: r.toolCalls };
}
