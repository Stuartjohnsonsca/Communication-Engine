import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { classifyAndRecordInbound } from "@/lib/sentiment/record";
import { getMemberLifecycleState, isDraftingPermitted } from "@/lib/lifecycle";
import { reportError } from "@/lib/observability";

/**
 * Item 50 — produce a Draft for an ingested inbound message **without
 * a User pressing a button**.
 *
 * The Communication Engine's product premise is "remove the risk of
 * missed emails and delay" — historically that has only been true for
 * messages the user pastes / forwards into `/drafts/new` (which hits
 * `/api/ai/draft` POST). Channel-ingested inbound messages landed in
 * `IngestedMessage` but never produced a Draft on their own, so an
 * un-watched mailbox could accumulate un-drafted inbound indefinitely.
 *
 * This module is the system-driven counterpart of `/api/ai/draft` POST:
 * same FCG/UCG resolution, same agent, same action-spawning, same
 * sentiment classification — minus the per-request rate-limit and RBAC
 * (the cron / inline-ingest entry-points apply their own gates).
 *
 * Cadence (acknowledgment vs substantive response) is FCG-driven: the
 * `draftAgent` reads the firm's FCG and emits `type: holding |
 * substantive | technical | holding_research` with a
 * `fcgWindowDeadline` for the substantive follow-up. We persist that
 * verbatim. A separate Action ("Send substantive follow-up: …") is
 * auto-spawned when the agent returns `holdingRequired = true`.
 *
 * Skip conditions:
 *  - A Draft already exists for this IngestedMessage (any status,
 *    including DISCARDED — once we've produced anything for an
 *    inbound, regenerate is a user-driven decision).
 *  - The owning Membership isn't in an active lifecycle state
 *    (revoked / leaver-frozen / anonymised / suspended).
 *  - No COMMITTED FCG exists for the tenant.
 *  - The inbound is the User's own outbound bouncing back (sender
 *    matches the Membership's User email). Detecting that here keeps
 *    the cron sweep from drafting "responses" to copies of the user's
 *    own messages.
 */

const channelEnum: Record<string, "EMAIL" | "SLACK" | "TEAMS" | "LETTER" | "REPORT" | "WHATSAPP_BUSINESS" | "ANY"> = {
  email: "EMAIL",
  slack: "SLACK",
  teams: "TEAMS",
  letter: "LETTER",
  report: "REPORT",
  whatsapp_business: "WHATSAPP_BUSINESS",
  any: "ANY",
};

const draftKindMap: Record<string, "EMAIL" | "HOLDING" | "TECHNICAL" | "ACTION_ONLY"> = {
  substantive: "EMAIL",
  holding: "HOLDING",
  technical: "TECHNICAL",
  holding_research: "HOLDING",
};

export type ProduceFromInboundResult =
  | { result: "produced"; draftId: string; kind: string; holdingRequired: boolean }
  | { result: "skipped"; reason: string };

export async function produceDraftFromInbound(input: {
  tenantId: string;
  ingestedMessageId: string;
  membershipId: string;
}): Promise<ProduceFromInboundResult> {
  // Idempotency: any existing Draft (root or regenerated) means we've
  // already produced for this inbound. Regenerated drafts have
  // parentId set — for the skip check we only care whether SOMETHING
  // exists, not which generation.
  const existing = await superDb.draft.findFirst({
    where: { tenantId: input.tenantId, ingestedMessageId: input.ingestedMessageId },
    select: { id: true },
  });
  if (existing) return { result: "skipped", reason: "draft already exists" };

  const ingested = await superDb.ingestedMessage.findUnique({
    where: { id: input.ingestedMessageId },
  });
  if (!ingested) return { result: "skipped", reason: "ingested message not found" };
  if (ingested.tenantId !== input.tenantId) {
    return { result: "skipped", reason: "tenant mismatch" };
  }
  if (ingested.direction !== "IN") {
    return { result: "skipped", reason: "not an inbound message" };
  }

  const membership = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
    include: { user: { select: { email: true } } },
  });
  if (!membership) return { result: "skipped", reason: "membership not found" };

  // Don't draft a "response" to the User's own outbound bouncing in. The
  // ingest adapter occasionally surfaces sent items as IN (Gmail thread
  // pull, for example); without this check the engine would reply to
  // its own user.
  if (
    membership.user.email &&
    ingested.sender &&
    ingested.sender.trim().toLowerCase() === membership.user.email.toLowerCase()
  ) {
    return { result: "skipped", reason: "sender is the owning user" };
  }

  const lifecycle = getMemberLifecycleState(membership);
  if (!isDraftingPermitted(lifecycle)) {
    return { result: "skipped", reason: `drafting halted (${lifecycle.kind})` };
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: input.tenantId, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) return { result: "skipped", reason: "no committed FCG" };

  const ucg = await superDb.userCultureGuide.findFirst({
    where: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
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

  const noGo = await superDb.noGoSubject.findMany({ where: { tenantId: input.tenantId } });

  // Sender + body are the only inputs the agent strictly needs; subject
  // is helpful when present. Channel is best-effort — fall back to email
  // if the IM didn't capture a channel hint.
  const channelLabel = ingested.channelId ? "email" : "email";
  void channelLabel;

  const draft = await produceDraft({
    tenantId: input.tenantId,
    fcg: fcgJson,
    ucg: ucgJson,
    inbound: {
      channel: "email",
      sender: ingested.sender ?? undefined,
      subject: ingested.subject ?? undefined,
      body: ingested.body,
      receivedAt: (ingested.sentAt ?? ingested.createdAt).toISOString(),
    },
    noGoSubjects: noGo.map((n) => n.label),
  });

  type ActionCreate = {
    tenantId: string;
    membershipId: string;
    title: string;
    detail: string | null;
    type: "task" | "calendar" | "followup" | "research";
    dueAt: Date | null;
  };

  const llmActions: ActionCreate[] = draft.actions.map((a) => ({
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    title: a.title,
    detail: a.detail ?? null,
    type: a.type,
    dueAt: a.dueAt ? new Date(a.dueAt) : null,
  }));

  const synthesised: ActionCreate[] = [];
  const subjectLabel = ingested.subject?.trim() || "(no subject)";

  if (draft.holdingRequired && !llmActions.some((a) => a.type === "followup")) {
    synthesised.push({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      title: `Send substantive follow-up: ${subjectLabel}`,
      detail: draft.holdingReason ?? null,
      type: "followup",
      dueAt: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
    });
  }

  if (draft.researchTaskRequired && !llmActions.some((a) => a.type === "research")) {
    synthesised.push({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      title: `Research before responding: ${subjectLabel}`,
      detail: null,
      type: "research",
      dueAt: null,
    });
  }

  const created = await superDb.draft.create({
    data: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      ingestedMessageId: ingested.id,
      kind: draftKindMap[draft.type] ?? "EMAIL",
      channel: channelEnum[draft.channel] ?? "EMAIL",
      language: draft.language,
      subject: draft.subject ?? null,
      body: draft.body,
      citations: draft.citations as Prisma.InputJsonValue,
      holdingRequired: draft.holdingRequired,
      holdingReason: draft.holdingReason ?? null,
      fcgWindowDeadline: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
      noGoSubjectHit: draft.noGoSubjectHit,
      researchTaskRequired: draft.researchTaskRequired,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
      inboundChannel: "email",
      inboundSender: ingested.sender ?? null,
      inboundSubject: ingested.subject ?? null,
      inboundBody: ingested.body,
      actions: {
        create: [...llmActions, ...synthesised],
      },
    },
    include: { actions: true },
  });

  // Sentiment classification runs alongside auto-drafting — same posture
  // as the /api/ai/draft route. Failures swallowed; sentiment is
  // monitoring, not a gate.
  classifyAndRecordInbound({
    tenantId: input.tenantId,
    assignedToMembershipId: input.membershipId,
    ingestedMessageId: ingested.id,
    inbound: {
      channel: "email",
      sender: ingested.sender ?? undefined,
      subject: ingested.subject ?? undefined,
      body: ingested.body,
    },
  }).catch((err) => {
    reportError(err, {
      route: "lib/drafts/produce-from-inbound",
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      extra: { ingestedMessageId: ingested.id, draftId: created.id },
    }, "auto-draft sentiment classify failed");
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "DRAFT_PRODUCED",
    actorMembershipId: null, // system-driven; no user actor
    subjectType: "Draft",
    subjectId: created.id,
    payload: {
      kind: created.kind,
      holdingRequired: created.holdingRequired,
      actions: created.actions.length,
      autoSpawnedActions: synthesised.length,
      autoProduced: true,
      ingestedMessageId: ingested.id,
      fcgWindowDeadline: created.fcgWindowDeadline?.toISOString() ?? null,
    },
  });

  return {
    result: "produced",
    draftId: created.id,
    kind: created.kind,
    holdingRequired: created.holdingRequired,
  };
}
