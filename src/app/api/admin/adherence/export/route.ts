import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  getAllAdherenceEscalations,
  formatAdherenceEscalationsAsCsv,
  type AdherenceExportWindow,
} from "@/lib/adherence/escalations-export";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 89 — uncapped per-escalation CSV export of
 * adherence escalations (acknowledged + open-overdue in the selected
 * window).
 *
 * Sister endpoint to /api/admin/sentiment/export (item 83) on the
 * adherence pillar: same RBAC posture (governance not commercial —
 * `adherence:export` is FIRM_ADMIN + FCT_MEMBER), same audit-on-export
 * pattern, same bogus-window-snaps-to-30 behaviour as the other
 * exporters (items 68 / 76 / 83). The /adherence/escalations page is
 * firm-wide for FCT/Admin (via the existing `members:read` gate); the
 * export is firm-wide for the same callers — it's a compliance-grade
 * artefact, not a self-view.
 */

const WINDOWS = [7, 30, 90] as const;

function parseWindow(raw: string | null): AdherenceExportWindow {
  const n = Number(raw);
  if (WINDOWS.includes(n as AdherenceExportWindow)) {
    return n as AdherenceExportWindow;
  }
  return 30;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("tenant");
    if (!slug) {
      return NextResponse.json({ error: "missing tenant" }, { status: 400 });
    }
    const ctx = await getTenantContext(slug);
    if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    requirePermission(ctx.membership.role, "adherence:export");

    const windowDays = parseWindow(url.searchParams.get("window"));
    const responses = await getAllAdherenceEscalations({
      tenantId: ctx.tenant.id,
      windowDays,
    });

    // Resolve member labels in one query — union of sender + acknowledger
    // ids across both buckets so the CSV reads as human names not opaque
    // membership ids. Mirrors item 83's pattern.
    const memberIdSet = new Set<string>();
    for (const r of responses.acknowledged) {
      memberIdSet.add(r.membershipId);
      if (r.acknowledgedByMembershipId) {
        memberIdSet.add(r.acknowledgedByMembershipId);
      }
    }
    for (const r of responses.openOverdue) {
      memberIdSet.add(r.membershipId);
    }
    const memberIds = Array.from(memberIdSet);
    const memberships = memberIds.length
      ? await superDb.membership.findMany({
          where: { id: { in: memberIds } },
          include: { user: { select: { email: true, name: true } } },
        })
      : [];
    const memberLabels = new Map<string, string>(
      memberships.map((m) => [m.id, m.user.name ?? m.user.email ?? m.id]),
    );

    await writeAuditEvent({
      tenantId: ctx.tenant.id,
      eventType: "ADHERENCE_ESCALATIONS_EXPORTED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        windowDays,
        format: "csv",
        counts: {
          acknowledged: responses.acknowledged.length,
          openOverdue: responses.openOverdue.length,
        },
      },
    });

    const body = formatAdherenceEscalationsAsCsv(responses, memberLabels);
    const filename = `adherence-escalations-${slug}-${windowDays}d-${Date.now()}.csv`;
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return safeApiError(err, {
      ctx: { route: "/api/admin/adherence/export" },
    });
  }
}
