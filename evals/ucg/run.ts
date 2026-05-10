import type { Adapter } from "../lib/types";
import { ucgChatTurn } from "@/lib/ai/agents/ucgAgent";
import type { ChatMessage } from "@/lib/ai/providers/types";

type Input = {
  tenantId?: string;
  fcg: unknown;
  ucg?: unknown;
  history: ChatMessage[];
};

export const ucgAdapter: Adapter = {
  role: "ucg",
  async run(raw) {
    const input = raw as Input;
    return ucgChatTurn({
      tenantId: input.tenantId ?? "eval-tenant",
      fcg: input.fcg,
      ucg: input.ucg,
      history: input.history,
    });
  },
};
