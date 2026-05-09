import { notFound, redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
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
    },
  });
  if (!meeting) notFound();

  const isAuthor = meeting.paperAuthorMembershipId === ctx.membership.id;
  const isAdmin = ctx.membership.role === "FIRM_ADMIN" || ctx.membership.role === "FCT_MEMBER";
  const canActOnPaper = isAuthor || isAdmin;

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
    canActOnPaper,
    participants: meeting.participants.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      isExternal: p.isExternal,
      isMeetingCreator: p.isMeetingCreator,
    })),
  };

  return <MeetingDetailClient tenantSlug={tenantSlug} meeting={detail} />;
}
