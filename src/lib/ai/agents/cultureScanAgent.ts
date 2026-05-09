import { callTool } from "@/lib/ai/client";
import { cultureScanSystem, type CultureScanContext } from "@/lib/ai/caching";
import { cultureScanTool } from "@/lib/ai/tools";
import { cultureScanResult, type CultureScanResult } from "@/lib/ai/schemas";

export type CultureScanInput = CultureScanContext;

/**
 * Firm Culture Scan analyser (PRD §5.1.1). Single forced tool call. The
 * model receives a sampled corpus of FCT-member communications and returns
 * a proposed FCG (rules + signature + summary + gaps). The server then lifts
 * `proposedRules` into a staged `FCGProposal` — promotion still requires the
 * §6 quorum vote, so this never bypasses governance.
 */
export async function analyseCultureScan(input: CultureScanInput): Promise<{
  result: CultureScanResult;
  modelRunId?: string;
}> {
  const system = await cultureScanSystem(input);

  const userMsg =
    "Analyse the corpus and produce a proposed Firm Culture Guide via " +
    "`respond_with_culture_scan`. Ground every rule in observed messages — " +
    "use `evidenceMessageIds` to point at the messages you used. Skip any " +
    "category the corpus does not support and list it in `gapsFlagged`.";

  const { output, modelRunId } = await callTool<unknown>({
    role: "culture-scan",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: cultureScanTool,
  });

  return { result: cultureScanResult.parse(output), modelRunId };
}
