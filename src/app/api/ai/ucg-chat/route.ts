import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { ucgChatTurn } from "@/lib/ai/agents/ucgAgent";
import type { ChatMessage } from "@/lib/ai/providers/types";
import { requirePermission } from "@/lib/rbac";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";

const inputSchema = z.object({
  tenantSlug: z.string(),
  ucgId: z.string().optional(),
  userMessage: z.string(),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "ucg:write:self");

  const rl = await rateLimitByMembership(
    ctx.membership.id, ctx.tenant.id, "draft", 60, 60 * 60,
  );
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const committed = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!committed) {
    return NextResponse.json(
      { error: "No committed FCG yet. Ask the Firm Culture Team to publish one before drafting your UCG." },
      { status: 409 },
    );
  }
  const fcgJson = {
    version: committed.version,
    rules: committed.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      mandatory: r.mandatory,
      channelOverrides: r.channelOverrides,
    })),
  };

  // Find or create UCG (DRAFT)
  let ucg = parsed.data.ucgId
    ? await superDb.userCultureGuide.findFirst({
        where: { id: parsed.data.ucgId, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      })
    : await superDb.userCultureGuide.findFirst({
        where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id, status: "DRAFT" },
      });
  if (!ucg) {
    const lastVersion = await superDb.userCultureGuide.findFirst({
      where: { membershipId: ctx.membership.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    ucg = await superDb.userCultureGuide.create({
      data: {
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
        version: (lastVersion?.version ?? 0) + 1,
        status: "DRAFT",
        basedOnFcgId: committed.id,
      },
    });
  }

  const turns = await superDb.uCGChatTurn.findMany({
    where: { ucgId: ucg.id },
    orderBy: { createdAt: "asc" },
  });
  const history: ChatMessage[] = turns.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.content,
  }));

  await superDb.uCGChatTurn.create({
    data: {
      tenantId: ctx.tenant.id,
      ucgId: ucg.id,
      role: "user",
      content: parsed.data.userMessage,
    },
  });
  history.push({ role: "user", content: parsed.data.userMessage });

  const ucgRules = await superDb.uCGRule.findMany({ where: { ucgId: ucg.id } });
  const ucgJson = {
    version: ucg.version,
    rules: ucgRules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      narrowsFcgRule: r.narrowsFcgRule,
    })),
  };

  const result = await ucgChatTurn({
    tenantId: ctx.tenant.id,
    fcg: fcgJson,
    ucg: ucgJson,
    history,
  });

  // Apply staged tool calls — for Phase 1 we only handle propose_user_rule and finalise_ucg
  const upCat = (v: unknown) => {
    const valid = ["TONE","RESPONSE_TIME","SALUTATION","SIGNOFF","SIGNATURE","MANDATORY_PHRASE","PROHIBITED_PHRASE","ESCALATION","REGULATORY","LANGUAGE"];
    const up = String(v ?? "").toUpperCase();
    return (valid.includes(up) ? up : "TONE") as never;
  };
  const upChan = (v: unknown) => {
    const valid = ["EMAIL","SLACK","TEAMS","LETTER","REPORT","WHATSAPP_BUSINESS","ANY"];
    const up = String(v ?? "").toUpperCase();
    return (valid.includes(up) ? up : "ANY") as never;
  };

  for (const tc of result.toolCalls) {
    if (tc.name === "propose_user_rule") {
      const ruleInput = tc.input as { action: "add" | "modify" | "remove"; rule: Record<string, unknown> };
      const r = ruleInput.rule;
      if (ruleInput.action === "remove") {
        await superDb.uCGRule.deleteMany({ where: { ucgId: ucg.id, externalId: r.externalId as string } });
      } else {
        await superDb.uCGRule.upsert({
          where: { ucgId_externalId: { ucgId: ucg.id, externalId: r.externalId as string } },
          create: {
            tenantId: ctx.tenant.id,
            ucgId: ucg.id,
            externalId: r.externalId as string,
            category: upCat(r.category),
            channel: upChan(r.channel),
            statement: r.statement as string,
            payload: (r.payload ?? {}) as never,
            narrowsFcgRule: (r.narrowsFcgRule ?? null) as string | null,
            channelOverrides: (r.channelOverrides ?? null) as never,
          },
          update: {
            category: upCat(r.category),
            channel: upChan(r.channel),
            statement: r.statement as string,
            payload: (r.payload ?? {}) as never,
            narrowsFcgRule: (r.narrowsFcgRule ?? null) as string | null,
            channelOverrides: (r.channelOverrides ?? null) as never,
          },
        });
      }
    }
  }

  await superDb.uCGChatTurn.create({
    data: {
      tenantId: ctx.tenant.id,
      ucgId: ucg.id,
      role: "assistant",
      content: result.message,
      toolCalls: result.toolCalls as unknown as object,
    },
  });

  // Item 115 — return the post-turn rules list + UCG status so the
  // client can render the actual current state. The previous client
  // tried to refresh via `fetch(pathname).then(x => x.text())` then
  // threw the response away, so rules stayed at their initial-load
  // count and the User couldn't see that the chat had done anything.
  const rulesAfter = await superDb.uCGRule.findMany({
    where: { ucgId: ucg.id },
    orderBy: { externalId: "asc" },
  });
  const ucgAfter = await superDb.userCultureGuide.findUnique({
    where: { id: ucg.id },
    select: { status: true, judgeStatus: true },
  });

  return NextResponse.json({
    ucgId: ucg.id,
    message: result.message,
    toolCalls: result.toolCalls,
    rules: rulesAfter.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      narrowsFcgRule: r.narrowsFcgRule,
    })),
    status: ucgAfter?.status ?? null,
    judgeStatus: ucgAfter?.judgeStatus ?? null,
  });
}
