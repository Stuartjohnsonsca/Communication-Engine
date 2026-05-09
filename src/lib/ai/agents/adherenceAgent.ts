import { callTool } from "@/lib/ai/client";
import { adherenceSystem } from "@/lib/ai/caching";
import { adherenceTool } from "@/lib/ai/tools";
import { adherence, type Adherence } from "@/lib/ai/schemas";

export type AdherenceInput = {
  tenantId: string;
  fcg: unknown;
  ucg: unknown;
  channel: string;
  inbound?: { sender?: string | null; subject?: string | null; body?: string | null };
  sent: { subject?: string | null; body: string };
  /** Minutes between inbound receipt and the sent communication. Optional —
   *  the judge returns `not_applicable` for `responseTime` when omitted. */
  responseLatencyMin?: number | null;
};

/**
 * Adherence judge — separate model role from the drafting agent (PRD §9.1).
 * Scores one sent communication against the FCG and UCG and returns a
 * structured per-dimension verdict plus per-rule findings.
 */
export async function scoreAdherence(input: AdherenceInput): Promise<{
  result: Adherence;
  modelRunId?: string;
}> {
  const system = await adherenceSystem({ fcg: input.fcg, ucg: input.ucg });

  const userMsg =
    "# Sent communication (what the user actually sent)\n\n" +
    "```json\n" +
    JSON.stringify(
      {
        channel: input.channel,
        responseLatencyMin: input.responseLatencyMin ?? null,
        inbound: input.inbound ?? null,
        sent: { subject: input.sent.subject ?? null, body: input.sent.body },
      },
      null,
      2,
    ) +
    "\n```\n\nReturn one structured score via `respond_with_adherence`.";

  const { output, modelRunId } = await callTool<unknown>({
    role: "adherence",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: adherenceTool,
  });

  return { result: adherence.parse(output), modelRunId };
}
