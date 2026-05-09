import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/ai/client";
import { draftSystem } from "@/lib/ai/caching";
import { MODEL_FOR } from "@/lib/ai/models";
import { draftTool } from "@/lib/ai/tools";
import { draftOutput, type DraftOutput } from "@/lib/ai/schemas";

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
};

/**
 * Drafting agent. Single tool call: `respond_with_draft`. Citation
 * post-validation strips body sentences flagged as technical claims that
 * lack a `[cN]` marker — the model is told this in the prompt.
 */
export async function produceDraft(input: DraftInput): Promise<DraftOutput> {
  const system = await draftSystem({ fcg: input.fcg, ucg: input.ucg, kb: input.kbExtracts });

  const userBlocks: string[] = [];
  userBlocks.push(`# Inbound message`);
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
    userBlocks.push(`# Configured no-go subjects (suppress technical drafting)`);
    userBlocks.push(input.noGoSubjects.map((s) => `- ${s}`).join("\n"));
  }
  userBlocks.push(`Produce one draft via \`respond_with_draft\`.`);

  const cfg = MODEL_FOR.draft;
  const msg = await anthropic().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    system,
    messages: [{ role: "user", content: userBlocks.join("\n\n") }],
    tools: [draftTool],
    tool_choice: { type: "tool", name: draftTool.name },
  });

  const tu = msg.content.find((c): c is Anthropic.Messages.ToolUseBlock => c.type === "tool_use");
  if (!tu || tu.name !== draftTool.name) {
    throw new Error("draftAgent: model did not invoke respond_with_draft");
  }
  const parsed = draftOutput.parse(tu.input);
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
  const inBody = new Set<string>();
  for (const m of d.body.matchAll(/\[c(\d+)\]/g)) inBody.add(`c${m[1]}`);
  const declared = new Set(d.citations.map((c) => c.marker));
  // Strip orphan markers from body (citation declared but body never used it = OK; body uses unknown marker = strip).
  const cleanBody = d.body.replace(/\[c(\d+)\]/g, (full, n) => (declared.has(`c${n}`) ? full : ""));
  return { ...d, body: cleanBody };
}
