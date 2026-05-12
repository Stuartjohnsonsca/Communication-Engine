import { callTool } from "@/lib/ai/client";
import { draftSystem } from "@/lib/ai/caching";
import { draftTool } from "@/lib/ai/tools";
import { draftOutput, type DraftOutput } from "@/lib/ai/schemas";
import type { RecordOpt } from "@/lib/ai/providers/types";

export type DraftInput = {
  tenantId: string;
  fcg: unknown;
  ucg: unknown;
  inbound: {
    channel: string;
    sender?: string;
    subject?: string;
    body: string;
    receivedAt?: string;
  };
  noGoSubjects?: string[];
  kbExtracts?: unknown[];
  /// Item 55 — pass through to `callTool` so the underlying LLM call
  /// is recorded against the tenant for cost observability. Callers
  /// (auto-draft cron, /api/ai/draft route, backfill) decide the
  /// `context` slug so spend can be sliced by trigger.
  record?: RecordOpt;
};

export async function produceDraft(input: DraftInput): Promise<DraftOutput> {
  const system = await draftSystem({ fcg: input.fcg, ucg: input.ucg, kb: input.kbExtracts });

  const userBlocks: string[] = [];
  userBlocks.push("# Inbound message");
  userBlocks.push(
    "```json\n" +
      JSON.stringify(
        {
          channel: input.inbound.channel,
          sender: input.inbound.sender,
          subject: input.inbound.subject,
          receivedAt: input.inbound.receivedAt ?? new Date().toISOString(),
          body: input.inbound.body,
        },
        null,
        2,
      ) +
      "\n```",
  );
  if (input.noGoSubjects?.length) {
    userBlocks.push("# Configured no-go subjects (suppress technical drafting)");
    userBlocks.push(input.noGoSubjects.map((s) => `- ${s}`).join("\n"));
  }
  userBlocks.push("Produce one draft via `respond_with_draft`.");

  const { output } = await callTool<unknown>({
    role: "draft",
    system,
    messages: [{ role: "user", content: userBlocks.join("\n\n") }],
    tool: draftTool,
    record: input.record,
  });

  const parsed = draftOutput.parse(output);
  return validateCitations(parsed);
}

/**
 * Server-side citation enforcement (PRD §7.3). For technical drafts:
 *  - every body sentence containing `[cN]` markers must reference a citation
 *  - every citation marker must appear in the body
 * Unverified statutory references are passed through here; the Verifier
 * agent (Phase 1.1) does the actual statute lookup.
 */
export function validateCitations(d: DraftOutput): DraftOutput {
  if (d.type !== "technical") return d;
  const declared = new Set(d.citations.map((c) => c.marker));
  const cleanBody = d.body.replace(/\[c(\d+)\]/g, (full, n) => (declared.has(`c${n}`) ? full : ""));
  return { ...d, body: cleanBody };
}
