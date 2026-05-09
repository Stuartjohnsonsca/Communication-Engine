import { callTool } from "@/lib/ai/client";
import { sentimentSystem } from "@/lib/ai/caching";
import { sentimentTool } from "@/lib/ai/tools";
import { sentiment, type Sentiment } from "@/lib/ai/schemas";

export type SentimentInput = {
  channel: string;
  sender?: string | null;
  subject?: string | null;
  body: string;
};

/**
 * Sentiment classifier (PRD §9.3) — extreme-positive / extreme-negative
 * boundary detector for *counterparty dissatisfaction with firm handling*.
 * Runs on inbound external communications; outgoing-comm sentiment is gated
 * by per-User opt-in and not handled here.
 */
export async function classifySentiment(input: SentimentInput): Promise<{
  result: Sentiment;
  modelRunId?: string;
}> {
  const system = await sentimentSystem();

  const userMsg =
    "# Inbound communication\n\n" +
    "```json\n" +
    JSON.stringify(
      {
        channel: input.channel,
        sender: input.sender ?? null,
        subject: input.subject ?? null,
        body: input.body,
      },
      null,
      2,
    ) +
    "\n```\n\nReturn one classification via `respond_with_sentiment`.";

  const { output, modelRunId } = await callTool<unknown>({
    role: "sentiment",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: sentimentTool,
  });

  return { result: sentiment.parse(output), modelRunId };
}
