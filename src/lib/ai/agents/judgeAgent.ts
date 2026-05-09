import { callTool } from "@/lib/ai/client";
import { judgeSystem } from "@/lib/ai/caching";
import { judgeTool } from "@/lib/ai/tools";
import { judgement, type Judgement } from "@/lib/ai/schemas";

/**
 * Judge agent — separate request, no chat history. The Judge sees the
 * authoritative FCG and the candidate UCG, returns a structured Judgement,
 * and never produces freeform text.
 *
 * "Separate model instance" per PRD §5.3 is satisfied because this is a
 * fresh request with its own system prompt that never includes any chat
 * history from the UCG drafting agent.
 */
export async function judgeUcg(opts: {
  fcg: unknown;
  ucg: unknown;
  tenantId: string;
}): Promise<Judgement> {
  const system = await judgeSystem({ fcg: opts.fcg });
  const userMsg =
    "Evaluate the following candidate UCG against the FCG above.\n\n" +
    "```json\n" +
    JSON.stringify(opts.ucg, null, 2) +
    "\n```";

  const { output } = await callTool<unknown>({
    role: "judge",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: judgeTool,
  });

  return judgement.parse(output);
}
