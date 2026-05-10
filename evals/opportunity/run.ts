import type { Adapter } from "../lib/types";
import { classifyOpportunity } from "@/lib/ai/agents/opportunityAgent";

type Input = {
  channel: string;
  sender?: string | null;
  subject?: string | null;
  body: string;
  context: { jurisdiction: string; serviceLineHints?: string[] };
};

export const opportunityAdapter: Adapter = {
  role: "opportunity",
  async run(raw) {
    const input = raw as Input;
    const { result } = await classifyOpportunity({
      channel: input.channel,
      sender: input.sender,
      subject: input.subject,
      body: input.body,
      context: input.context,
    });
    return result;
  },
};
