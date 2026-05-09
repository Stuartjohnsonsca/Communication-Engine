import { callTool } from "@/lib/ai/client";
import { meetingPaperSystem } from "@/lib/ai/caching";
import { meetingPaperTool } from "@/lib/ai/tools";
import { meetingPaper, type MeetingPaper } from "@/lib/ai/schemas";

export type MeetingPaperParticipant = {
  name: string;
  email?: string | null;
  isExternal: boolean;
  isMeetingCreator?: boolean;
};

export type MeetingPaperInput = {
  tenantId: string;
  fcg: unknown;
  meeting: {
    title: string;
    description?: string | null;
    location?: string | null;
    startsAt: string;
    durationMin: number;
    paperAuthor: string;
    shortNotice: boolean;
    leadTimeWorkingDays: number;
  };
  participants: MeetingPaperParticipant[];
  priorContext?: unknown[];
};

/**
 * Meeting paper drafter (PRD §7.4). Produces a structured agenda + discussion
 * paper + open questions for the paper-author to review, edit and issue. The
 * agent never issues — that's an explicit user action recorded as
 * `MEETING_PAPER_ISSUED`.
 */
export async function produceMeetingPaper(input: MeetingPaperInput): Promise<{
  result: MeetingPaper;
  modelRunId?: string;
}> {
  const system = await meetingPaperSystem({
    fcg: input.fcg,
    meeting: input.meeting,
    participants: input.participants,
    priorContext: input.priorContext,
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
    (input.meeting.shortNotice
      ? `Note: this meeting is scheduled less than the FCG-defined lead time of ${input.meeting.leadTimeWorkingDays} working days. Acknowledge the short notice in the paper body.\n\n`
      : "") +
    "Produce one agenda + paper via `respond_with_meeting_paper`.";

  const { output, modelRunId } = await callTool<unknown>({
    role: "meeting-paper",
    system,
    messages: [{ role: "user", content: userMsg }],
    tool: meetingPaperTool,
  });

  return { result: meetingPaper.parse(output), modelRunId };
}
