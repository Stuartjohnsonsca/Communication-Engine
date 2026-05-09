import { callTool } from "@/lib/ai/client";
import { opportunitySystem, type OpportunityContext } from "@/lib/ai/caching";
import { opportunityTool } from "@/lib/ai/tools";
import { opportunity, type Opportunity } from "@/lib/ai/schemas";

export type OpportunityAgentInput = {
  channel: string;
  sender?: string | null;
  subject?: string | null;
  body: string;
  context: OpportunityContext;
};

/**
 * Sales Identifier classifier (PRD §8). Reads one inbound external
 * communication and returns a structured opportunity classification. The
 * caller applies the confidence floor (see `lib/opportunities/detect.ts`)
 * to decide whether to persist a candidate.
 */
export async function classifyOpportunity(input: OpportunityAgentInput): Promise<{
  result: Opportunity;
  modelRunId?: string;
}> {
  const system = await opportunitySystem(input.context);

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
    "\n```\n\nReturn one classification via `respond_with_opportunity`.";

  const { output, modelRunId } = await callTool<unknown>({
    role: "opportunity",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: opportunityTool,
  });

  return { result: opportunity.parse(output), modelRunId };
}
