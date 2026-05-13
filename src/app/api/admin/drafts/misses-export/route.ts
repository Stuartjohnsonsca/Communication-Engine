import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  getAllFcgMisses,
  formatFcgMissesAsCsv,
  type DraftRollupWindow,
} from "@/lib/drafts";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 76 — uncapped CSV export of FCG-window
 * misses (sent-after + open-overdue).
 *
 * Sister endpoint to /api/admin/drafts/export (item 68): same RBAC
 * gate (`drafts:read-rollup` — FIRM_ADMIN + FCT_MEMBER, governance
 * not commercial), same audit-on-export pattern, same bogus-window-
 * snaps-to-30 behaviour. The difference is the payload: the rollup
 * exporter writes one wide-table summary, this writes every breach
 * row so a monthly compliance review has the full list.
 */

const WINDOWS = [7, 30, 90] as const;

function parseWindow(raw: string | null): DraftRollupWindow {
  const n = Number(raw);
  if (WINDOWS.includes(n as DraftRollupWindow)) return n as DraftRollupWindow;
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
    requirePermission(ctx.membership.role, "drafts:read-rollup");

    const windowDays = parseWindow(url.searchParams.get("window"));
    const misses = await getAllFcgMisses({
      tenantId: ctx.tenant.id,
      windowDays,
    });

    // Resolve member labels in one query, union of both buckets so a
    // member appearing only in open-overdue still gets a human name.
    const memberIdSet = new Set<string>();
    for (const r of misses.sentAfterWindow) {
      if (r.membershipId) memberIdSet.add(r.membershipId);
    }
    for (const r of misses.openOverdue) {
      if (r.membershipId) memberIdSet.add(r.membershipId);
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
      eventType: "FCG_MISSES_EXPORTED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        windowDays,
        format: "csv",
        counts: {
          sentAfter: misses.sentAfterWindow.length,
          openOverdue: misses.openOverdue.length,
        },
      },
    });

    const body = formatFcgMissesAsCsv(misses, memberLabels);
    const filename = `fcg-misses-${slug}-${windowDays}d-${Date.now()}.csv`;
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return safeApiError(err, {
      ctx: { route: "/api/admin/drafts/misses-export" },
    });
  }
}
