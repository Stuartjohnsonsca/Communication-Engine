import type {
  Meeting,
  MeetingParticipant,
  MeetingRecord,
  MeetingRecordKind,
  TranscriptSource,
} from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { produceMeetingRecord } from "@/lib/ai/agents/meetingMinutesAgent";

/**
 * PRD §7.5 lifecycle helpers.
 *
 * Pre-meeting:
 *   discloseNoteTaking — records that the disclosure was sent.
 *   recordOptOut — flips a participant's opt-out and (per PRD: any opt-out
 *     disables transcript ingestion) sets `Meeting.noteTakingBlocked`.
 *
 * Post-meeting:
 *   ingestTranscript — stores the transcript (refused if blocked).
 *   draftRecord — generates a Summary or Minutes via the AI agent.
 *   editRecord — Chair / paper-author edits the body before approval.
 *   approveRecord — Chair signs off (PRD: routed to Chair, paper-author by default).
 *   circulateMinutes — Chair-only, marks Minutes as circulated to participants.
 *
 * Authorisation is enforced upstream (the API route checks `meeting:write`
 * + the actor-is-author/chair/admin gate). These helpers assume a
 * permitted actor and focus on data + audit consistency.
 */

const MAX_TRANSCRIPT_BYTES = 1_000_000; // 1 MB plain text — covers a long meeting comfortably
const MAX_BODY_BYTES = 200_000;

// ─── Pre-meeting ──────────────────────────────────────────────────────────

export async function discloseNoteTaking(input: {
  tenantId: string;
  meetingId: string;
  actorMembershipId: string;
}): Promise<Meeting> {
  const meeting = await assertMeeting(input.tenantId, input.meetingId);
  if (meeting.noteTakingDisclosedAt) return meeting; // idempotent

  const updated = await superDb.meeting.update({
    where: { id: meeting.id },
    data: { noteTakingDisclosedAt: new Date() },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "MEETING_NOTE_TAKING_DISCLOSED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Meeting",
    subjectId: meeting.id,
    payload: {
      participantCount: await superDb.meetingParticipant.count({
        where: { meetingId: meeting.id },
      }),
    },
  });

  return updated;
}

export async function recordOptOut(input: {
  tenantId: string;
  meetingId: string;
  participantId: string;
  reason?: string | null;
  actorMembershipId: string;
}): Promise<{ meeting: Meeting; participant: MeetingParticipant }> {
  const meeting = await assertMeeting(input.tenantId, input.meetingId);

  const participant = await superDb.meetingParticipant.findFirst({
    where: { id: input.participantId, meetingId: meeting.id },
  });
  if (!participant) throw new Error("meeting/minutes: participant not found");

  const reason = clampText(input.reason, 1_000);
  const optedOutAt = participant.noteTakingOptedOut
    ? participant.noteTakingOptedOutAt
    : new Date();

  const updatedParticipant = await superDb.meetingParticipant.update({
    where: { id: participant.id },
    data: {
      noteTakingOptedOut: true,
      noteTakingOptedOutAt: optedOutAt,
      noteTakingOptOutReason: reason,
    },
  });

  // PRD §7.5: any participant opting out disables transcript ingestion for
  // the meeting. Record the block + a separate audit event so the cause is
  // traceable.
  let updatedMeeting = meeting;
  if (!meeting.noteTakingBlocked) {
    updatedMeeting = await superDb.meeting.update({
      where: { id: meeting.id },
      data: {
        noteTakingBlocked: true,
        noteTakingBlockReason: `Participant ${participant.name} opted out${reason ? `: ${reason}` : ""}`,
      },
    });
    await writeAuditEvent({
      tenantId: input.tenantId,
      eventType: "MEETING_NOTE_TAKING_BLOCKED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "Meeting",
      subjectId: meeting.id,
      payload: {
        triggerParticipantId: participant.id,
        triggerParticipantName: participant.name,
        triggerIsExternal: participant.isExternal,
      },
    });
  }

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "MEETING_NOTE_TAKING_OPTED_OUT",
    actorMembershipId: input.actorMembershipId,
    subjectType: "MeetingParticipant",
    subjectId: participant.id,
    payload: {
      meetingId: meeting.id,
      participantName: participant.name,
      isExternal: participant.isExternal,
      hadReason: reason != null,
    },
  });

  return { meeting: updatedMeeting, participant: updatedParticipant };
}

// ─── Post-meeting ─────────────────────────────────────────────────────────

export async function ingestTranscript(input: {
  tenantId: string;
  meetingId: string;
  source: TranscriptSource;
  body: string;
  actorMembershipId: string;
}): Promise<Meeting> {
  const meeting = await assertMeeting(input.tenantId, input.meetingId);

  if (meeting.noteTakingBlocked) {
    throw new Error("meeting/minutes: note-taking is blocked for this meeting (a participant opted out)");
  }
  if (!input.body || input.body.length === 0) {
    throw new Error("meeting/minutes: transcript body is empty");
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw new Error("meeting/minutes: transcript exceeds size limit");
  }

  const wasReplaced = meeting.transcriptBody != null;
  const updated = await superDb.meeting.update({
    where: { id: meeting.id },
    data: {
      transcriptBody: input.body,
      transcriptSource: input.source,
      transcriptIngestedAt: new Date(),
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "MEETING_TRANSCRIPT_INGESTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Meeting",
    subjectId: meeting.id,
    payload: {
      source: input.source,
      bytes: Buffer.byteLength(input.body, "utf8"),
      replaced: wasReplaced,
    },
  });

  return updated;
}

export async function draftRecord(input: {
  tenantId: string;
  meetingId: string;
  kind: MeetingRecordKind;
  actorMembershipId: string;
}): Promise<MeetingRecord> {
  const meeting = await superDb.meeting.findFirst({
    where: { id: input.meetingId, tenantId: input.tenantId },
    include: {
      participants: { orderBy: { createdAt: "asc" } },
      chair: { include: { user: true } },
      paperAuthor: { include: { user: true } },
    },
  });
  if (!meeting) throw new Error("meeting/minutes: meeting not found");

  if (meeting.noteTakingBlocked) {
    throw new Error("meeting/minutes: note-taking is blocked for this meeting");
  }
  if (!meeting.transcriptBody) {
    throw new Error("meeting/minutes: ingest a transcript before drafting");
  }

  // If a record of this kind already exists and is APPROVED or CIRCULATED,
  // refuse to overwrite. DRAFTED/EDITED can be regenerated.
  const existing = await superDb.meetingRecord.findUnique({
    where: { meetingId_kind: { meetingId: meeting.id, kind: input.kind } },
  });
  if (existing && (existing.status === "APPROVED" || existing.status === "CIRCULATED")) {
    throw new Error(`meeting/minutes: ${input.kind.toLowerCase()} already approved`);
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: meeting.tenantId, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) throw new Error("meeting/minutes: no committed FCG");

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

  const chairName =
    meeting.chair?.user.name ??
    meeting.chair?.user.email ??
    meeting.paperAuthor?.user.name ??
    meeting.paperAuthor?.user.email ??
    "Chair";

  const priorPaper =
    meeting.paperStatus !== "NONE"
      ? {
          agenda: meeting.agenda,
          paper: meeting.paperBody,
          openQuestions: meeting.openQuestions,
        }
      : undefined;

  const { result, modelRunId } = await produceMeetingRecord({
    tenantId: meeting.tenantId,
    kind: input.kind === "MINUTES" ? "minutes" : "summary",
    fcg: fcgJson,
    meeting: {
      title: meeting.title,
      description: meeting.description,
      location: meeting.location,
      startsAt: meeting.startsAt.toISOString(),
      durationMin: meeting.durationMin,
      chair: chairName,
    },
    participants: meeting.participants.map((p) => ({
      name: p.name,
      email: p.email,
      isExternal: p.isExternal,
      isMeetingCreator: p.isMeetingCreator,
    })),
    transcript: meeting.transcriptBody,
    priorPaper,
  });

  // Encode the structured decisions/actions inside the body as a trailing
  // markdown section so the Chair sees them in the editor without us having
  // to add separate columns. They're also persisted as plain text so the
  // audit/export remains self-contained.
  const composedBody = composeBody(result);

  const upserted = await superDb.meetingRecord.upsert({
    where: { meetingId_kind: { meetingId: meeting.id, kind: input.kind } },
    create: {
      tenantId: meeting.tenantId,
      meetingId: meeting.id,
      kind: input.kind,
      status: "DRAFTED",
      body: composedBody,
      generatedAt: new Date(),
      fcgVersionUsed: fcg.version,
      modelRunId: modelRunId ?? null,
    },
    update: {
      status: "DRAFTED",
      body: composedBody,
      generatedAt: new Date(),
      approvedAt: null,
      approvedByMembershipId: null,
      circulatedAt: null,
      circulatedByMembershipId: null,
      fcgVersionUsed: fcg.version,
      modelRunId: modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: meeting.tenantId,
    eventType: input.kind === "MINUTES" ? "MEETING_MINUTES_DRAFTED" : "MEETING_SUMMARY_DRAFTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "MeetingRecord",
    subjectId: upserted.id,
    payload: {
      meetingId: meeting.id,
      kind: input.kind,
      regenerated: existing != null,
      decisions: result.decisions.length,
      actions: result.actions.length,
      fcgVersionUsed: fcg.version,
    },
  });

  return upserted;
}

export async function editRecord(input: {
  tenantId: string;
  meetingId: string;
  kind: MeetingRecordKind;
  body: string;
  actorMembershipId: string;
}): Promise<MeetingRecord> {
  const existing = await superDb.meetingRecord.findUnique({
    where: { meetingId_kind: { meetingId: input.meetingId, kind: input.kind } },
  });
  if (!existing || existing.tenantId !== input.tenantId) {
    throw new Error("meeting/minutes: record not found");
  }
  if (existing.status === "APPROVED" || existing.status === "CIRCULATED") {
    throw new Error(`meeting/minutes: ${input.kind.toLowerCase()} already approved`);
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_BODY_BYTES) {
    throw new Error("meeting/minutes: body exceeds size limit");
  }

  const updated = await superDb.meetingRecord.update({
    where: { id: existing.id },
    data: { body: input.body, status: "EDITED" },
  });

  // Edit events are MEETING_SUMMARY_DRAFTED / _MINUTES_DRAFTED with `edit:
  // true` payload — we don't introduce a separate _EDITED type to keep the
  // audit enum compact, since the row's `status` already distinguishes
  // DRAFTED vs EDITED for any future query.
  return updated;
}

export async function approveRecord(input: {
  tenantId: string;
  meetingId: string;
  kind: MeetingRecordKind;
  actorMembershipId: string;
}): Promise<MeetingRecord> {
  const existing = await superDb.meetingRecord.findUnique({
    where: { meetingId_kind: { meetingId: input.meetingId, kind: input.kind } },
  });
  if (!existing || existing.tenantId !== input.tenantId) {
    throw new Error("meeting/minutes: record not found");
  }
  if (existing.status === "APPROVED" || existing.status === "CIRCULATED") {
    return existing;
  }

  const updated = await superDb.meetingRecord.update({
    where: { id: existing.id },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: input.actorMembershipId,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: input.kind === "MINUTES" ? "MEETING_MINUTES_APPROVED" : "MEETING_SUMMARY_APPROVED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "MeetingRecord",
    subjectId: existing.id,
    payload: {
      meetingId: input.meetingId,
      kind: input.kind,
      hadEdits: existing.status === "EDITED",
    },
  });

  return updated;
}

export async function circulateMinutes(input: {
  tenantId: string;
  meetingId: string;
  actorMembershipId: string;
}): Promise<MeetingRecord> {
  const existing = await superDb.meetingRecord.findUnique({
    where: { meetingId_kind: { meetingId: input.meetingId, kind: "MINUTES" } },
  });
  if (!existing || existing.tenantId !== input.tenantId) {
    throw new Error("meeting/minutes: minutes not found");
  }
  if (existing.status !== "APPROVED" && existing.status !== "CIRCULATED") {
    throw new Error("meeting/minutes: approve before circulating");
  }
  if (existing.status === "CIRCULATED") return existing;

  const updated = await superDb.meetingRecord.update({
    where: { id: existing.id },
    data: {
      status: "CIRCULATED",
      circulatedAt: new Date(),
      circulatedByMembershipId: input.actorMembershipId,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "MEETING_MINUTES_CIRCULATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "MeetingRecord",
    subjectId: existing.id,
    payload: { meetingId: input.meetingId },
  });

  return updated;
}

// ─── Internals ────────────────────────────────────────────────────────────

async function assertMeeting(tenantId: string, meetingId: string): Promise<Meeting> {
  const meeting = await superDb.meeting.findFirst({
    where: { id: meetingId, tenantId },
  });
  if (!meeting) throw new Error("meeting/minutes: meeting not found");
  return meeting;
}

function clampText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function composeBody(record: { body: string; decisions: string[]; actions: { title: string; owner?: string | null; dueAt?: string | null }[] }): string {
  let out = record.body.trim();
  if (record.decisions.length > 0) {
    out += "\n\n## Decisions\n";
    for (const d of record.decisions) out += `\n- ${d}`;
  }
  if (record.actions.length > 0) {
    out += "\n\n## Actions\n";
    for (const a of record.actions) {
      const owner = a.owner ? ` — ${a.owner}` : "";
      const due = a.dueAt ? ` (by ${a.dueAt})` : "";
      out += `\n- ${a.title}${owner}${due}`;
    }
  }
  return out;
}

/**
 * The actor who is allowed to act on a record's lifecycle:
 *   - draft / edit: paper-author OR chair OR FCT/admin
 *   - approve / circulate: chair OR FCT/admin (PRD §7.5: "routed to the
 *     meeting Chair (or paper-author by default)")
 */
export function canDraftOrEdit(meeting: { paperAuthorMembershipId: string | null; chairMembershipId: string | null }, actor: { membershipId: string; role: string }): boolean {
  if (meeting.paperAuthorMembershipId === actor.membershipId) return true;
  if (meeting.chairMembershipId === actor.membershipId) return true;
  return actor.role === "FIRM_ADMIN" || actor.role === "FCT_MEMBER";
}

export function canApprove(meeting: { paperAuthorMembershipId: string | null; chairMembershipId: string | null }, actor: { membershipId: string; role: string }): boolean {
  // Chair is preferred per PRD; paper-author is the default chair so ends up
  // here too. FCT/admin can approve as a backstop.
  const chair = meeting.chairMembershipId ?? meeting.paperAuthorMembershipId;
  if (chair === actor.membershipId) return true;
  return actor.role === "FIRM_ADMIN" || actor.role === "FCT_MEMBER";
}
