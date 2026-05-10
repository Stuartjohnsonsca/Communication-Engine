import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { fcgChatTurn } from "@/lib/ai/agents/fcgAgent";
import type { ChatMessage } from "@/lib/ai/providers/types";
import { requirePermission } from "@/lib/rbac";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";

const inputSchema = z.object({
  tenantSlug: z.string(),
  proposalId: z.string().optional(),
  userMessage: z.string(),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:propose");

  const rl = await rateLimitByMembership(
    ctx.membership.id, ctx.tenant.id, "draft", 60, 60 * 60,
  );
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  // Load committed FCG (most recent COMMITTED), or null on first run
  const committed = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  const committedJson = committed
    ? {
        version: committed.version,
        language: committed.language,
        rules: committed.rules.map((r) => ({
          externalId: r.externalId,
          category: r.category,
          channel: r.channel,
          statement: r.statement,
          payload: r.payload,
          mandatory: r.mandatory,
          channelOverrides: r.channelOverrides,
        })),
      }
    : { version: 0, rules: [], note: "No FCG committed yet — drafting from scratch." };

  // Find or create proposal
  let proposal = parsed.data.proposalId
    ? await superDb.fCGProposal.findFirst({
        where: { id: parsed.data.proposalId, tenantId: ctx.tenant.id },
      })
    : null;
  if (!proposal) {
    proposal = await superDb.fCGProposal.create({
      data: {
        tenantId: ctx.tenant.id,
        parentFcgId: committed?.id ?? null,
        title: "New FCG proposal",
        body: "",
        diff: { ops: [] },
        proposedById: ctx.membership.id,
        state: "DRAFTING",
      },
    });
  }

  // Load history from chat turns
  const turns = await superDb.fCGChatTurn.findMany({
    where: { proposalId: proposal.id },
    orderBy: { createdAt: "asc" },
  });
  const history: ChatMessage[] = turns.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.content,
  }));

  // Persist user turn
  await superDb.fCGChatTurn.create({
    data: {
      tenantId: ctx.tenant.id,
      proposalId: proposal.id,
      membershipId: ctx.membership.id,
      role: "user",
      content: parsed.data.userMessage,
    },
  });
  history.push({ role: "user", content: parsed.data.userMessage });

  const draftFcg = (proposal.diff as { ops?: unknown[] })?.ops ?? null;

  const result = await fcgChatTurn({
    tenantId: ctx.tenant.id,
    committedFcg: committedJson,
    draftFcg,
    history,
  });

  // Apply staged tool calls to the proposal diff
  const ops: unknown[] = Array.isArray(draftFcg) ? [...(draftFcg as unknown[])] : [];
  for (const tc of result.toolCalls) {
    if (tc.name === "propose_rule_change" || tc.name === "finalise_fcg") {
      ops.push({ tool: tc.name, input: tc.input });
    }
  }
  await superDb.fCGProposal.update({
    where: { id: proposal.id },
    data: { diff: { ops } as never },
  });

  await superDb.fCGChatTurn.create({
    data: {
      tenantId: ctx.tenant.id,
      proposalId: proposal.id,
      membershipId: null,
      role: "assistant",
      content: result.message,
      toolCalls: result.toolCalls as unknown as object,
    },
  });

  return NextResponse.json({
    proposalId: proposal.id,
    message: result.message,
    toolCalls: result.toolCalls,
    diffOps: ops,
  });
}
