import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import {
  approveRecord,
  canApprove,
  canDraftOrEdit,
  circulateMinutes,
  draftRecord,
  editRecord,
} from "@/lib/meetings/minutes";

const KIND = z.enum(["SUMMARY", "MINUTES"]);

const draftSchema = z.object({ tenantSlug: z.string(), kind: KIND });
const editSchema = z.object({
  tenantSlug: z.string(),
  kind: KIND,
  body: z.string().min(1).max(200_000),
});
const transitionSchema = z.object({
  tenantSlug: z.string(),
  kind: KIND,
  action: z.enum(["approve", "circulate"]),
});

/**
 * Single endpoint for the post-meeting record lifecycle (PRD §7.5):
 *   POST   = generate (or regenerate) the structured record
 *   PATCH  = Chair / paper-author edits the body before approval
 *   PUT    = transition: approve, or (Minutes only) circulate
 *
 * Authorisation: draft/edit allowed for paper-author, Chair, or FCT/admin.
 * Approve/circulate restricted to Chair (paper-author by default) or
 * FCT/admin per PRD ("routed to the meeting Chair … for approval before
 * circulation").
 */

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = draftSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    select: { paperAuthorMembershipId: true, chairMembershipId: true },
  });
  if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canDraftOrEdit(meeting, { membershipId: ctx.membership.id, role: ctx.membership.role })) {
    return NextResponse.json({ error: "only paper-author, Chair, or FCT/admin can draft" }, { status: 403 });
  }

  try {
    const record = await draftRecord({
      tenantId: ctx.tenant.id,
      meetingId: id,
      kind: parsed.data.kind,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ record });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    select: { paperAuthorMembershipId: true, chairMembershipId: true },
  });
  if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canDraftOrEdit(meeting, { membershipId: ctx.membership.id, role: ctx.membership.role })) {
    return NextResponse.json({ error: "only paper-author, Chair, or FCT/admin can edit" }, { status: 403 });
  }

  try {
    const record = await editRecord({
      tenantId: ctx.tenant.id,
      meetingId: id,
      kind: parsed.data.kind,
      body: parsed.data.body,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ record });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    select: { paperAuthorMembershipId: true, chairMembershipId: true },
  });
  if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canApprove(meeting, { membershipId: ctx.membership.id, role: ctx.membership.role })) {
    return NextResponse.json({ error: "only the Chair (or FCT/admin) can approve or circulate" }, { status: 403 });
  }

  if (parsed.data.action === "circulate" && parsed.data.kind !== "MINUTES") {
    return NextResponse.json({ error: "only Minutes can be circulated" }, { status: 400 });
  }

  try {
    const record =
      parsed.data.action === "approve"
        ? await approveRecord({
            tenantId: ctx.tenant.id,
            meetingId: id,
            kind: parsed.data.kind,
            actorMembershipId: ctx.membership.id,
          })
        : await circulateMinutes({
            tenantId: ctx.tenant.id,
            meetingId: id,
            actorMembershipId: ctx.membership.id,
          });
    return NextResponse.json({ record });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
