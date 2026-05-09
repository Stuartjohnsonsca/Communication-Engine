import { notFound, redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { canApprove, canDraftOrEdit } from "@/lib/meetings/minutes";
import MeetingDetailClient, { type MeetingDetail } from "./MeetingDetailClient";

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
}) {
  const { tenantSlug, id } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    include: {
      participants: { orderBy: { createdAt: "asc" } },
      paperAuthor: { include: { user: true } },
      createdBy: { include: { user: true } },
      chair: { include: { user: true } },
      records: true,
    },
  });
  if (!meeting) notFound();

  const isAuthor = meeting.paperAuthorMembershipId === ctx.membership.id;
  const isAdmin = ctx.membership.role === "FIRM_ADMIN" || ctx.membership.role === "FCT_MEMBER";
  const canActOnPaper = isAuthor || isAdmin;
  const canEditRecord = canDraftOrEdit(meeting, {
    membershipId: ctx.membership.id,
    role: ctx.membership.role,
  });
  const canChairApprove = canApprove(meeting, {
    membershipId: ctx.membership.id,
    role: ctx.membership.role,
  });

  const summary = meeting.records.find((r) => r.kind === "SUMMARY");
  const minutes = meeting.records.find((r) => r.kind === "MINUTES");

  const detail: MeetingDetail = {
    id: meeting.id,
    title: meeting.title,
    description: meeting.description,
    location: meeting.location,
    startsAt: meeting.startsAt.toISOString(),
    durationMin: meeting.durationMin,
    leadTimeWorkingDays: meeting.leadTimeWorkingDays,
    shortNotice: meeting.shortNotice,
    paperStatus: meeting.paperStatus,
    paperBody: meeting.paperBody,
    agenda: (meeting.agenda ?? []) as MeetingDetail["agenda"],
    openQuestions: (meeting.openQuestions ?? []) as string[],
    paperGeneratedAt: meeting.paperGeneratedAt?.toISOString() ?? null,
    paperIssuedAt: meeting.paperIssuedAt?.toISOString() ?? null,
    paperFcgVersionUsed: meeting.paperFcgVersionUsed,
    paperAuthorName:
      meeting.paperAuthor?.user.name ?? meeting.paperAuthor?.user.email ?? "—",
    creatorName: meeting.createdBy?.user.name ?? meeting.createdBy?.user.email ?? "—",
    chairName: meeting.chair?.user.name ?? meeting.chair?.user.email ?? null,
    canActOnPaper,
    canEditRecord,
    canChairApprove,
    participants: meeting.participants.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      isExternal: p.isExternal,
      isMeetingCreator: p.isMeetingCreator,
      noteTakingOptedOut: p.noteTakingOptedOut,
      noteTakingOptedOutAt: p.noteTakingOptedOutAt?.toISOString() ?? null,
    })),
    noteTaking: {
      disclosedAt: meeting.noteTakingDisclosedAt?.toISOString() ?? null,
      blocked: meeting.noteTakingBlocked,
      blockReason: meeting.noteTakingBlockReason,
    },
    transcript: meeting.transcriptBody
      ? {
          source: meeting.transcriptSource ?? "MANUAL",
          ingestedAt: meeting.transcriptIngestedAt?.toISOString() ?? null,
          bytes: Buffer.byteLength(meeting.transcriptBody, "utf8"),
          excerpt: meeting.transcriptBody.slice(0, 600),
        }
      : null,
    summary: summary
      ? {
          status: summary.status,
          body: summary.body,
          generatedAt: summary.generatedAt.toISOString(),
          approvedAt: summary.approvedAt?.toISOString() ?? null,
          fcgVersionUsed: summary.fcgVersionUsed,
        }
      : null,
    minutes: minutes
      ? {
          status: minutes.status,
          body: minutes.body,
          generatedAt: minutes.generatedAt.toISOString(),
          approvedAt: minutes.approvedAt?.toISOString() ?? null,
          circulatedAt: minutes.circulatedAt?.toISOString() ?? null,
          fcgVersionUsed: minutes.fcgVersionUsed,
        }
      : null,
  };

  return <MeetingDetailClient tenantSlug={tenantSlug} meeting={detail} />;
}
