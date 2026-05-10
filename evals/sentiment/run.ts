import type { Adapter } from "../lib/types";
import { classifySentiment } from "@/lib/ai/agents/sentimentAgent";

type Input = {
  channel: string;
  sender?: string | null;
  subject?: string | null;
  body: string;
};

export const sentimentAdapter: Adapter = {
  role: "sentiment",
  async run(raw) {
    const { result } = await classifySentiment(raw as Input);
    return result;
  },
};
