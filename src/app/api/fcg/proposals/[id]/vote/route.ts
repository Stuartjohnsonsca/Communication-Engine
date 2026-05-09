import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { evaluate } from "@/lib/voting/state-machine";
import { eligibleVoterIds } from "@/lib/voting/quorum";

const inputSchema = z.object({
  tenantSlug: z.string(),
  decision: z.enum(["APPROVE","REJECT","ABSTAIN"]),
  comment: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:vote");

  const proposal = await superDb.fCGProposal.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (proposal.state !== "OPEN_FOR_VOTE") {
    return NextResponse.json({ error: `proposal is ${proposal.state}` }, { status: 400 });
  }

  const eligible = await eligibleVoterIds(ctx.tenant.id);
  if (!eligible.includes(ctx.membership.id)) {
    return NextResponse.json({ error: "not eligible to vote" }, { status: 403 });
  }

  await superDb.fCGVote.upsert({
    where: { proposalId_membershipId: { proposalId: proposal.id, membershipId: ctx.membership.id } },
    create: {
      tenantId: ctx.tenant.id,
      proposalId: proposal.id,
      membershipId: ctx.membership.id,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
    },
    update: { decision: parsed.data.decision, comment: parsed.data.comment },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "FCG_VOTE_CAST",
    actorMembershipId: ctx.membership.id,
    subjectType: "FCGProposal",
    subjectId: proposal.id,
    payload: { decision: parsed.data.decision },
  });

  // Re-evaluate proposal state
  const votes = await superDb.fCGVote.findMany({ where: { proposalId: proposal.id } });
  const decision = evaluate(proposal, votes, eligible.length, ctx.tenant.quorumPct);

  if (decision.state === "PASSED") {
    try {
      const newFcgId = await commitProposal(proposal.id, ctx.tenant.id, ctx.membership.id);
      await superDb.fCGProposal.update({
        where: { id: proposal.id },
        data: { state: "PASSED", decidedAt: new Date(), newFcgId },
      });
      return NextResponse.json({ proposalState: "PASSED", reason: decision.reason, newFcgId });
    } catch (e) {
      console.error("commitProposal failed:", e);
      return NextResponse.json(
        {
          proposalState: "OPEN_FOR_VOTE",
          error: "Vote recorded but commit failed: " + (e instanceof Error ? e.message : String(e)),
        },
        { status: 500 },
      );
    }
  }
  if (decision.state === "FAILED" || decision.state === "EXPIRED") {
    await superDb.fCGProposal.update({
      where: { id: proposal.id },
      data: { state: decision.state, decidedAt: new Date() },
    });
    await writeAuditEvent({
      tenantId: ctx.tenant.id,
      eventType: decision.state === "FAILED" ? "FCG_PROPOSAL_FAILED" : "FCG_PROPOSAL_EXPIRED",
      actorMembershipId: ctx.membership.id,
      subjectType: "FCGProposal",
      subjectId: proposal.id,
      payload: { reason: decision.reason },
    });
    return NextResponse.json({ proposalState: decision.state, reason: decision.reason });
  }
  return NextResponse.json({ proposalState: "OPEN_FOR_VOTE", reason: decision.reason });
}

/**
 * Claude's tool schema uses lowercase enum values ("tone", "email") for
 * readability; the Prisma enums are uppercase. Normalise here so an invalid
 * cast doesn't roll back the commit transaction silently.
 */
function normaliseCategory(v: unknown): never {
  const valid = ["TONE","RESPONSE_TIME","SALUTATION","SIGNOFF","SIGNATURE","MANDATORY_PHRASE","PROHIBITED_PHRASE","ESCALATION","REGULATORY","LANGUAGE"];
  const up = String(v ?? "").toUpperCase();
  return (valid.includes(up) ? up : "TONE") as never;
}
function normaliseChannel(v: unknown): never {
  const valid = ["EMAIL","SLACK","TEAMS","LETTER","REPORT","WHATSAPP_BUSINESS","ANY"];
  const up = String(v ?? "").toUpperCase();
  return (valid.includes(up) ? up : "ANY") as never;
}

/**
 * Commit a passed proposal: build a new FCG version from
 * (parent FCG ∘ proposal.diff.ops), supersede the old, write the audit event.
 */
async function commitProposal(proposalId: string, tenantId: string, actorMembershipId: string): Promise<string> {
  return superDb.$transaction(async (tx) => {
    const proposal = await tx.fCGProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const parent = proposal.parentFcgId
      ? await tx.firmCultureGuide.findUnique({ where: { id: proposal.parentFcgId }, include: { rules: true } })
      : null;
    const lastVersion = await tx.firmCultureGuide.findFirst({
      where: { tenantId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (lastVersion?.version ?? 0) + 1;

    // Build new rule set
    const ruleMap = new Map<string, Prisma.FCGRuleCreateWithoutFcgInput>();
    for (const r of parent?.rules ?? []) {
      ruleMap.set(r.externalId, {
        tenantId,
        externalId: r.externalId,
        category: r.category,
        channel: r.channel,
        statement: r.statement,
        payload: r.payload as Prisma.InputJsonValue,
        rationale: r.rationale,
        mandatory: r.mandatory,
        priority: r.priority,
        evidenceRefs: r.evidenceRefs as Prisma.InputJsonValue,
        channelOverrides: r.channelOverrides as Prisma.InputJsonValue,
      });
    }
    const ops = ((proposal.diff as { ops?: { tool: string; input: Record<string, unknown> }[] })?.ops) ?? [];
    for (const op of ops) {
      if (op.tool === "propose_rule_change") {
        const action = op.input.action as "add" | "modify" | "remove";
        const r = op.input.rule as Record<string, unknown>;
        const externalId = r.externalId as string;
        if (action === "remove") ruleMap.delete(externalId);
        else
          ruleMap.set(externalId, {
            tenantId,
            externalId,
            category: normaliseCategory(r.category),
            channel: normaliseChannel(r.channel),
            statement: r.statement as string,
            payload: (r.payload ?? {}) as Prisma.InputJsonValue,
            rationale: (r.rationale as string) ?? null,
            mandatory: !!r.mandatory,
            priority: (r.priority as number) ?? 100,
            evidenceRefs: (r.evidenceRefs ?? []) as Prisma.InputJsonValue,
            channelOverrides: (r.channelOverrides ?? null) as Prisma.InputJsonValue,
          });
      } else if (op.tool === "finalise_fcg") {
        const rules = (op.input.rules as Record<string, unknown>[]) ?? [];
        ruleMap.clear();
        for (const r of rules) {
          ruleMap.set(r.externalId as string, {
            tenantId,
            externalId: r.externalId as string,
            category: normaliseCategory(r.category),
            channel: normaliseChannel(r.channel),
            statement: r.statement as string,
            payload: (r.payload ?? {}) as Prisma.InputJsonValue,
            rationale: (r.rationale as string) ?? null,
            mandatory: !!r.mandatory,
            priority: (r.priority as number) ?? 100,
            evidenceRefs: (r.evidenceRefs ?? []) as Prisma.InputJsonValue,
            channelOverrides: (r.channelOverrides ?? null) as Prisma.InputJsonValue,
          });
        }
      }
    }

    const newFcg = await tx.firmCultureGuide.create({
      data: {
        tenantId,
        version: nextVersion,
        status: "COMMITTED",
        language: parent?.language ?? "en-GB",
        effectiveAt: new Date(),
        parentId: parent?.id ?? null,
        committedById: actorMembershipId,
        rules: { create: Array.from(ruleMap.values()) },
      },
    });

    if (parent) {
      await tx.firmCultureGuide.update({
        where: { id: parent.id },
        data: { status: "SUPERSEDED", supersededAt: new Date() },
      });
    }
    return newFcg.id;
  }).then(async (newFcgId) => {
    await writeAuditEvent({
      tenantId,
      eventType: "FCG_COMMITTED",
      actorMembershipId,
      subjectType: "FirmCultureGuide",
      subjectId: newFcgId,
      payload: { fromProposal: proposalId },
    });
    return newFcgId;
  });
}
