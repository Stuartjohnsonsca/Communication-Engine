import type { Adapter } from "../lib/types";
import { fcgChatTurn } from "@/lib/ai/agents/fcgAgent";
import type { ChatMessage } from "@/lib/ai/providers/types";

type Input = {
  tenantId?: string;
  committedFcg: unknown;
  draftFcg?: unknown;
  history: ChatMessage[];
};

export const fcgAdapter: Adapter = {
  role: "fcg",
  async run(raw) {
    const input = raw as Input;
    return fcgChatTurn({
      tenantId: input.tenantId ?? "eval-tenant",
      committedFcg: input.committedFcg,
      draftFcg: input.draftFcg,
      history: input.history,
    });
  },
};
