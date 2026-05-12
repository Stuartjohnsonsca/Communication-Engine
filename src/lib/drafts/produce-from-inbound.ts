import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { classifyAndRecordInbound } from "@/lib/sentiment/record";
import { getMemberLifecycleState, isDraftingPermitted } from "@/lib/lifecycle";
import { reportError } from "@/lib/observability";
import { dispatchNotification } from "@/lib/notifications/dispatch";

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

/// Stable, machine-readable skip codes. The auto-sweep aggregates these
/// into a per-pass histogram (item 52). Adding a new code does NOT
/// require a migration — the UI renders unknown codes verbatim. The
/// human-readable `reason` stays alongside for one-shot debugging.
export type ProduceFromInboundSkipCode =
  | "draft_already_exists"
  | "ingested_not_found"
  | "tenant_mismatch"
  | "not_inbound"
  | "membership_not_found"
  | "sender_is_owning_user"
  | "drafting_halted"
  | "no_committed_fcg"
  /// Item 58 — tenant operator paused background drafting via
  /// /admin/channels. Distinct from `drafting_halted` (per-Member
  /// lifecycle gate) — the tenant-wide pause stops cron + backfill
  /// for every Member regardless of lifecycle state.
  | "auto_draft_paused"
  /// Item 62 — this IngestedMessage has been quarantined after
  /// `QUARANTINE_THRESHOLD` consecutive failed draft attempts.
  /// The sweep filter normally excludes quarantined rows; this
  /// code only fires for direct callers that bypass the sweep
  /// candidate query.
  | "quarantined";

/**
 * Item 62 — number of consecutive failed draft attempts before an
 * IngestedMessage is quarantined from further sweep ticks. Three is
 * deliberately below item 59's `FAILURE_THRESHOLD` (5) so a single
 * broken inbound is contained before it can trip the tenant-wide
 * circuit breaker. With the 5-min cron cadence, an inbound that
 * fails every tick reaches quarantine in ~15 minutes; the breaker
 * needs ~25 minutes of single-inbound failure to trip.
 *
 * The `quarantineReason` column is capped to this many chars so a
 * stack-trace-flavoured error message doesn't blow up the row.
 */
export const QUARANTINE_THRESHOLD = 3;
const QUARANTINE_REASON_MAX = 500;

export type ProduceFromInboundResult =
  | { result: "produced"; draftId: string; kind: string; holdingRequired: boolean }
  | { result: "skipped"; reason: string; reasonCode: ProduceFromInboundSkipCode };

export async function produceDraftFromInbound(input: {
  tenantId: string;
  ingestedMessageId: string;
  membershipId: string;
}): Promise<ProduceFromInboundResult> {
  // Item 58 — tenant-level pause check. Cheapest possible gate: we
  // only need one column from one row, scoped by tenantId. This runs
  // BEFORE the idempotency check so a paused tenant doesn't churn
  // through every inbound looking for existing drafts.
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { autoDraftPausedAt: true },
  });
  if (tenant?.autoDraftPausedAt) {
    return {
      result: "skipped",
      reason: "auto-draft is paused for this tenant",
      reasonCode: "auto_draft_paused",
    };
  }

  // Idempotency: any existing Draft (root or regenerated) means we've
  // already produced for this inbound. Regenerated drafts have
  // parentId set — for the skip check we only care whether SOMETHING
  // exists, not which generation.
  const existing = await superDb.draft.findFirst({
    where: { tenantId: input.tenantId, ingestedMessageId: input.ingestedMessageId },
    select: { id: true },
  });
  if (existing)
    return {
      result: "skipped",
      reason: "draft already exists",
      reasonCode: "draft_already_exists",
    };

  const ingested = await superDb.ingestedMessage.findUnique({
    where: { id: input.ingestedMessageId },
  });
  if (!ingested)
    return {
      result: "skipped",
      reason: "ingested message not found",
      reasonCode: "ingested_not_found",
    };
  if (ingested.tenantId !== input.tenantId) {
    return { result: "skipped", reason: "tenant mismatch", reasonCode: "tenant_mismatch" };
  }
  if (ingested.direction !== "IN") {
    return { result: "skipped", reason: "not an inbound message", reasonCode: "not_inbound" };
  }

  const membership = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
    include: { user: { select: { email: true } } },
  });
  if (!membership)
    return {
      result: "skipped",
      reason: "membership not found",
      reasonCode: "membership_not_found",
    };

  // Don't draft a "response" to the User's own outbound bouncing in. The
  // ingest adapter occasionally surfaces sent items as IN (Gmail thread
  // pull, for example); without this check the engine would reply to
  // its own user.
  if (
    membership.user.email &&
    ingested.sender &&
    ingested.sender.trim().toLowerCase() === membership.user.email.toLowerCase()
  ) {
    return {
      result: "skipped",
      reason: "sender is the owning user",
      reasonCode: "sender_is_owning_user",
    };
  }

  const lifecycle = getMemberLifecycleState(membership);
  if (!isDraftingPermitted(lifecycle)) {
    return {
      result: "skipped",
      reason: `drafting halted (${lifecycle.kind})`,
      reasonCode: "drafting_halted",
    };
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: input.tenantId, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg)
    return { result: "skipped", reason: "no committed FCG", reasonCode: "no_committed_fcg" };

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

  // Item 62 — refuse to attempt a quarantined inbound. Belt-and-braces
  // for the sweep filter: a direct caller (e.g. a test) that hands us a
  // quarantined IM id should get a clean skip, not an LLM call.
  if (ingested.quarantinedFromDraftAt) {
    return {
      result: "skipped",
      reason: `inbound quarantined after ${ingested.draftAttemptCount} failed attempts`,
      reasonCode: "quarantined",
    };
  }

  // Item 62 — wrap the LLM call so a failure bumps `draftAttemptCount`,
  // stamps `lastDraftAttemptAt`, and trips quarantine at the threshold.
  // The error is re-thrown so the sweep's outer catch still counts it
  // (the breaker is opted-in via item 55's LlmCall recording, which
  // happens inside `produceDraft`; this layer is purely about per-IM
  // bookkeeping).
  let draft;
  try {
    draft = await produceDraft({
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
      // Item 55 — auto-draft path: system-driven, no actor membership.
      // The `auto-draft` context distinguishes cron spend from
      // User-pasted spend on /admin/usage.
      record: {
        tenantId: input.tenantId,
        context: "auto-draft",
        membershipId: null,
      },
    });
  } catch (err) {
    const now = new Date();
    const attemptCount = ingested.draftAttemptCount + 1;
    const errorMessage =
      err instanceof Error
        ? err.message.slice(0, QUARANTINE_REASON_MAX)
        : String(err).slice(0, QUARANTINE_REASON_MAX);
    const shouldQuarantine = attemptCount >= QUARANTINE_THRESHOLD;
    await superDb.ingestedMessage.update({
      where: { id: ingested.id },
      data: {
        draftAttemptCount: attemptCount,
        lastDraftAttemptAt: now,
        ...(shouldQuarantine
          ? {
              quarantinedFromDraftAt: now,
              quarantineReason: errorMessage,
            }
          : {}),
      },
    });
    if (shouldQuarantine) {
      await writeAuditEvent({
        tenantId: input.tenantId,
        eventType: "INBOUND_DRAFT_QUARANTINED",
        actorMembershipId: null,
        subjectType: "IngestedMessage",
        subjectId: ingested.id,
        payload: {
          ingestedMessageId: ingested.id,
          attemptCount,
          lastError: errorMessage,
        },
      });
      // Item 63 — mandatory notification to every active FIRM_ADMIN.
      // Without this, quarantined inbound only surfaces by visiting
      // /admin/channels, and a small backlog can grow silently. We
      // resolve `tenant.name` + admins lazily INSIDE the quarantine
      // branch so the per-failure happy path pays nothing.
      const tenant = await superDb.tenant.findUnique({
        where: { id: input.tenantId },
        select: { name: true },
      });
      const admins = await superDb.membership.findMany({
        where: {
          tenantId: input.tenantId,
          role: "FIRM_ADMIN",
          status: "ACTIVE",
        },
        include: { user: { select: { email: true } } },
      });
      const senderLabel = ingested.sender?.trim() || "(no sender)";
      const subjectLabel = ingested.subject?.trim() || "(no subject)";
      const dedupeKey = `quarantined:${ingested.id}`;
      for (const m of admins) {
        if (!m.user.email) continue;
        try {
          await dispatchNotification({
            tenantId: input.tenantId,
            membershipId: m.id,
            toEmail: m.user.email,
            kind: "inbound_draft_quarantined",
            dedupeKey,
            subject: `[${tenant?.name ?? "tenant"}] Inbound quarantined — investigate before retry`,
            text:
              `An inbound message failed ${attemptCount} consecutive draft attempts and has ` +
              `been quarantined. The auto-draft sweep will skip it on subsequent ticks until ` +
              `an operator manually retries from /admin/channels.\n\n` +
              `Sender: ${senderLabel}\n` +
              `Subject: ${subjectLabel}\n` +
              `Last error: ${errorMessage}\n\n` +
              `Common causes: malformed encoding, oversized attachment, prompt-template ` +
              `rejection. Investigate, then press Retry on /admin/channels to put the row ` +
              `back in the candidate pool.`,
            summary: `Quarantined: ${subjectLabel}`,
            href: `/admin/channels`,
            payload: {
              ingestedMessageId: ingested.id,
              attemptCount,
              lastError: errorMessage,
            },
          });
        } catch (notifyErr) {
          reportError(
            notifyErr,
            {
              route: "lib/drafts/produce-from-inbound",
              tenantId: input.tenantId,
              membershipId: m.id,
              extra: { ingestedMessageId: ingested.id },
            },
            "quarantine notification dispatch failed",
          );
        }
      }
    }
    throw err;
  }

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
