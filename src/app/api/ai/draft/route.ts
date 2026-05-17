import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { classifyAndRecordInbound } from "@/lib/sentiment/record";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { getMemberLifecycleState, isDraftingPermitted } from "@/lib/lifecycle";
import { reportError } from "@/lib/observability";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";
import { pushDraftToMailbox } from "@/lib/drafts/push-to-mailbox";

const inputSchema = z.object({
  tenantSlug: z.string(),
  inbound: z.object({
    channel: z.string().default("email"),
    sender: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    receivedAt: z.string().optional(),
  }),
});

const channelEnum: Record<string, "EMAIL" | "SLACK" | "TEAMS" | "LETTER" | "REPORT" | "WHATSAPP_BUSINESS" | "ANY"> = {
  email: "EMAIL", slack: "SLACK", teams: "TEAMS", letter: "LETTER", report: "REPORT", whatsapp_business: "WHATSAPP_BUSINESS", any: "ANY",
};
const draftKindMap: Record<string, "EMAIL" | "HOLDING" | "TECHNICAL" | "ACTION_ONLY"> = {
  substantive: "EMAIL", holding: "HOLDING", technical: "TECHNICAL", holding_research: "HOLDING",
};

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  // LLM endpoints are token-cost surfaces — cap per-Membership generation
  // even before lifecycle / FCG checks. 30 drafts/hour absorbs heavy real
  // use; sustained higher rates are almost certainly a runaway client.
  const rl = await rateLimitByMembership(
    ctx.membership.id, ctx.tenant.id, "draft", 30, 60 * 60,
  );
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  // PRD §14.3: drafting halts on revocation or while leaver-frozen. The
  // member can still hit /account to re-authorise during the 30-day grace.
  const lifecycle = getMemberLifecycleState(ctx.membership);
  if (!isDraftingPermitted(lifecycle)) {
    return NextResponse.json(
      { error: "drafting_halted", lifecycle: lifecycle.kind },
      { status: 409 },
    );
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) return NextResponse.json({ error: "no committed FCG" }, { status: 409 });

  // Drafting falls back to FCG-only when there is no live UCG, or when the
  // UCG is in CONFLICTED state but the user hasn't yet remediated. A
  // CONFLICTED UCG is still usable — only its individual auto-suspended
  // rules are filtered out below (PRD §5.2.2).
  const ucg = await superDb.userCultureGuide.findFirst({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      status: { in: ["COMMITTED", "CONFLICTED"] },
    },
    include: { rules: { where: { suspendedAt: null } } },
    orderBy: { version: "desc" },
  });

  const fcgJson = {
    version: fcg.version,
    rules: fcg.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      mandatory: r.mandatory,
      channelOverrides: r.channelOverrides,
    })),
  };
  const ucgJson = ucg
    ? {
        version: ucg.version,
        rules: ucg.rules.map((r) => ({
          externalId: r.externalId,
          category: r.category,
          channel: r.channel,
          statement: r.statement,
          payload: r.payload,
          narrowsFcgRule: r.narrowsFcgRule,
        })),
      }
    : { version: 0, rules: [] };

  const noGo = await superDb.noGoSubject.findMany({ where: { tenantId: ctx.tenant.id } });

  // Persist the inbound as an IngestedMessage so the Draft, the sentiment
  // signal and any future thread-aware features share one canonical row.
  const ingested = await superDb.ingestedMessage.create({
    data: {
      tenantId: ctx.tenant.id,
      direction: "IN",
      sender: parsed.data.inbound.sender ?? null,
      subject: parsed.data.inbound.subject ?? null,
      body: parsed.data.inbound.body,
      sentAt: parsed.data.inbound.receivedAt ? new Date(parsed.data.inbound.receivedAt) : null,
    },
  });

  // Drafting and sentiment classification are independent — run in parallel.
  // Sentiment failures must not block the draft (PRD §9.3 is a monitoring
  // feature, not a gate), so failures are swallowed and the signal omitted.
  const [draft] = await Promise.all([
    produceDraft({
      tenantId: ctx.tenant.id,
      fcg: fcgJson,
      ucg: ucgJson,
      inbound: parsed.data.inbound,
      noGoSubjects: noGo.map((n) => n.label),
      // Item 55 — manual-draft path. The Membership posted the
      // inbound themselves so their spend is attributable; auto-draft
      // (cron) uses context="auto-draft" with membershipId=null.
      record: {
        tenantId: ctx.tenant.id,
        context: "manual-draft",
        membershipId: ctx.membership.id,
      },
    }),
    classifyAndRecordInbound({
      tenantId: ctx.tenant.id,
      assignedToMembershipId: ctx.membership.id,
      ingestedMessageId: ingested.id,
      inbound: parsed.data.inbound,
    }).catch((err) => {
      reportError(err, {
        route: "api/ai/draft",
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
        extra: { ingestedMessageId: ingested.id },
      }, "sentiment classify failed");
      return null;
    }),
  ]);

  type ActionCreate = {
    tenantId: string;
    membershipId: string;
    title: string;
    detail: string | null;
    type: "task" | "calendar" | "followup" | "research";
    dueAt: Date | null;
  };

  const llmActions: ActionCreate[] = draft.actions.map((a) => ({
    tenantId: ctx.tenant.id,
    membershipId: ctx.membership.id,
    title: a.title,
    detail: a.detail ?? null,
    type: a.type,
    dueAt: a.dueAt ? new Date(a.dueAt) : null,
  }));

  // Synthesise actions from the structured flags so the new lifecycle
  // (complete/dismiss/reopen) has something concrete to track. We only add
  // them when the LLM did not already emit an action of the same type, to
  // avoid double-counting when the prompt covers both surfaces.
  const synthesised: ActionCreate[] = [];
  const subjectLabel = parsed.data.inbound.subject?.trim() || "(no subject)";

  if (draft.holdingRequired && !llmActions.some((a) => a.type === "followup")) {
    synthesised.push({
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      title: `Send substantive follow-up: ${subjectLabel}`,
      detail: draft.holdingReason ?? null,
      type: "followup",
      dueAt: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
    });
  }

  if (draft.researchTaskRequired && !llmActions.some((a) => a.type === "research")) {
    synthesised.push({
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      title: `Research before responding: ${subjectLabel}`,
      detail: null,
      type: "research",
      dueAt: null,
    });
  }

  const created = await superDb.draft.create({
    data: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      ingestedMessageId: ingested.id,
      kind: draftKindMap[draft.type] ?? "EMAIL",
      channel: channelEnum[draft.channel] ?? "EMAIL",
      language: draft.language,
      subject: draft.subject ?? null,
      body: draft.body,
      citations: draft.citations as never,
      holdingRequired: draft.holdingRequired,
      holdingReason: draft.holdingReason ?? null,
      fcgWindowDeadline: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
      noGoSubjectHit: draft.noGoSubjectHit,
      researchTaskRequired: draft.researchTaskRequired,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
      inboundChannel: parsed.data.inbound.channel,
      inboundSender: parsed.data.inbound.sender ?? null,
      inboundSubject: parsed.data.inbound.subject ?? null,
      inboundBody: parsed.data.inbound.body,
      actions: {
        create: [...llmActions, ...synthesised],
      },
    },
    include: { actions: true },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_PRODUCED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: created.id,
    payload: {
      kind: created.kind,
      holdingRequired: created.holdingRequired,
      actions: created.actions.length,
      autoSpawnedActions: synthesised.length,
    },
  });

  // Item 113 — also push the draft into the User's actual Outlook /
  // Gmail drafts folder so they can edit + send from their normal mail
  // client. Fire-and-forget; failures are logged inside the helper and
  // never bubble up — a draft pushed only to Postgres is still useful.
  void pushDraftToMailbox({
    tenantId: ctx.tenant.id,
    draftId: created.id,
    membershipId: ctx.membership.id,
  });

  return NextResponse.json({ draft: created, output: draft });
}
