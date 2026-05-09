import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { addWorkingDays } from "@/lib/working-days";

const participantSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200).nullable().optional(),
  isExternal: z.boolean().default(false),
  isMeetingCreator: z.boolean().default(false),
});

const inputSchema = z.object({
  tenantSlug: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(20000).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  startsAt: z.string(), // ISO
  durationMin: z.number().int().min(5).max(1440).default(60),
  leadTimeWorkingDays: z.number().int().min(0).max(15).default(3),
  participants: z.array(participantSchema).max(50).default([]),
});

/**
 * Schedule a new meeting (PRD §7.4). The creator becomes the paper-author by
 * default; an FCT/admin can reassign on the detail page. Short-notice flag is
 * computed at creation time (now + leadTimeWorkingDays vs startsAt) and
 * snapshotted on the row so it stays stable if the FCG lead time changes.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:create");

  const startsAt = new Date(parsed.data.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: "invalid startsAt" }, { status: 400 });
  }

  const leadDeadline = addWorkingDays(new Date(), parsed.data.leadTimeWorkingDays);
  const shortNotice = startsAt.getTime() < leadDeadline.getTime();

  // The creator is always added as a participant (internal, isMeetingCreator)
  // unless the form already includes them.
  const formCreator = parsed.data.participants.find((p) => p.isMeetingCreator);
  const participants = formCreator
    ? parsed.data.participants
    : [
        {
          name: ctx.user.name ?? ctx.user.email,
          email: ctx.user.email,
          isExternal: false,
          isMeetingCreator: true,
        },
        ...parsed.data.participants,
      ];

  const meeting = await superDb.meeting.create({
    data: {
      tenantId: ctx.tenant.id,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      location: parsed.data.location ?? null,
      startsAt,
      durationMin: parsed.data.durationMin,
      leadTimeWorkingDays: parsed.data.leadTimeWorkingDays,
      shortNotice,
      createdByMembershipId: ctx.membership.id,
      paperAuthorMembershipId: ctx.membership.id,
      participants: {
        create: participants.map((p) => ({
          tenantId: ctx.tenant.id,
          name: p.name,
          email: p.email ?? null,
          isExternal: p.isExternal,
          isMeetingCreator: p.isMeetingCreator,
        })),
      },
    },
    include: { participants: true },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "MEETING_CREATED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Meeting",
    subjectId: meeting.id,
    payload: {
      title: meeting.title,
      startsAt: startsAt.toISOString(),
      durationMin: meeting.durationMin,
      participantCount: meeting.participants.length,
      externalParticipantCount: meeting.participants.filter((p) => p.isExternal).length,
      shortNotice,
      leadTimeWorkingDays: meeting.leadTimeWorkingDays,
    },
  });

  return NextResponse.json({ meeting });
}
