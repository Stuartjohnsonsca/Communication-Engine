import { callTool } from "@/lib/ai/client";
import { meetingRecordSystem } from "@/lib/ai/caching";
import { meetingRecordTool } from "@/lib/ai/tools";
import { meetingRecord, type MeetingRecord } from "@/lib/ai/schemas";

export type MeetingMinutesParticipant = {
  name: string;
  email?: string | null;
  isExternal: boolean;
  isMeetingCreator?: boolean;
};

export type MeetingMinutesInput = {
  tenantId: string;
  /// "summary" yields a discursive prose Summary; "minutes" yields formal
  /// numbered Minutes per PRD §7.5.
  kind: "summary" | "minutes";
  fcg: unknown;
  meeting: {
    title: string;
    description?: string | null;
    location?: string | null;
    startsAt: string;
    durationMin: number;
    chair: string;
  };
  participants: MeetingMinutesParticipant[];
  transcript: string;
  priorPaper?: unknown;
};

/**
 * Post-meeting Summary / Minutes drafter (PRD §7.5). Caller has already
 * gated this on transcript-present + not-blocked. The agent never approves
 * or circulates — the Chair does that via the dedicated lifecycle endpoints.
 */
export async function produceMeetingRecord(input: MeetingMinutesInput): Promise<{
  result: MeetingRecord;
  modelRunId?: string;
}> {
  const system = await meetingRecordSystem({
    kind: input.kind,
    fcg: input.fcg,
    meeting: input.meeting,
    participants: input.participants,
    priorPaper: input.priorPaper,
  });

  const userMsg =
    "# Meeting\n\n" +
    "```json\n" +
    JSON.stringify(input.meeting, null, 2) +
    "\n```\n\n" +
    "# Participants\n\n" +
    "```json\n" +
    JSON.stringify(input.participants, null, 2) +
    "\n```\n\n" +
    "# Transcript\n\n" +
    "```\n" +
    input.transcript +
    "\n```\n\n" +
    `Produce one ${input.kind === "minutes" ? "formal Minutes" : "Summary"} record via \`respond_with_meeting_record\`.`;

  const { output, modelRunId } = await callTool<unknown>({
    role: "meeting-minutes",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: meetingRecordTool,
  });

  return { result: meetingRecord.parse(output), modelRunId };
}
