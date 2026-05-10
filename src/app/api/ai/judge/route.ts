import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { judgeUcg } from "@/lib/ai/agents/judgeAgent";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";

const inputSchema = z.object({
  tenantSlug: z.string(),
  ucgId: z.string(),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "ucg:write:self");

  const rl = await rateLimitByMembership(
    ctx.membership.id, ctx.tenant.id, "ai-judge", 20, 60 * 60,
  );
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const ucg = await superDb.userCultureGuide.findFirst({
    where: { id: parsed.data.ucgId, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    include: { rules: true, basedOnFcg: { include: { rules: true } } },
  });
  if (!ucg) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fcgJson = {
    version: ucg.basedOnFcg.version,
    rules: ucg.basedOnFcg.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      mandatory: r.mandatory,
    })),
  };
  const ucgJson = {
    version: ucg.version,
    rules: ucg.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      narrowsFcgRule: r.narrowsFcgRule,
    })),
  };

  const judgement = await judgeUcg({ fcg: fcgJson, ucg: ucgJson, tenantId: ctx.tenant.id });

  // Persist rulings
  await superDb.complianceRuling.deleteMany({ where: { ucgId: ucg.id } });
  await superDb.complianceRuling.createMany({
    data: judgement.rulings.map((r) => ({
      tenantId: ctx.tenant.id,
      ucgId: ucg.id,
      ucgRuleId: r.ucgRuleId,
      fcgRuleId: r.fcgClauseCited ?? null,
      verdict: r.verdict === "pass" ? "PASS" : r.verdict === "fail" ? "FAIL" : "NOT_APPLICABLE",
      severity: r.severity,
      explanation: r.explanation,
      suggestedFix: r.suggestedFix,
      judgeModel: "claude-sonnet-4-6",
    })),
  });

  const newStatus =
    judgement.overall === "pass"
      ? "JUDGED_PASS"
      : judgement.overall === "fail"
        ? "JUDGED_FAIL"
        : "JUDGED_FAIL"; // partial = blocked from commit too if any blocking failure
  await superDb.userCultureGuide.update({
    where: { id: ucg.id },
    data: { status: newStatus, judgeStatus: judgement.overall },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "UCG_JUDGED",
    actorMembershipId: ctx.membership.id,
    subjectType: "UserCultureGuide",
    subjectId: ucg.id,
    payload: { overall: judgement.overall, blockingCount: judgement.rulings.filter((r) => r.severity === "blocking").length },
  });

  return NextResponse.json(judgement);
}
