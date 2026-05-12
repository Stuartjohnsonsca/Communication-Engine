import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  computeDraftRollup,
  formatDraftsRollupAsCsv,
  type DraftRollupWindow,
} from "@/lib/drafts";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 68 — CSV export of the draft outcome rollup.
 *
 * Mirrors the audit-log exporter (item 49): one GET endpoint, returns
 * an attachment, writes a `DRAFTS_ROLLUP_EXPORTED` audit event on the
 * tenant chain.
 *
 * RBAC reuses `drafts:read-rollup` (same gate as the /admin/drafts
 * page). FCT_MEMBER is included for the same reason as the page —
 * outcome metrics are governance, not commercial.
 *
 * Window is `7 | 30 | 90` matching the page's selector; anything else
 * snaps to 30 (no error — the user agent gets the conservative window
 * rather than a 400, which matches how the page handles a bogus query
 * string).
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

    const rollup = await computeDraftRollup({
      tenantId: ctx.tenant.id,
      windowDays,
    });

    // Resolve member labels once so the CSV's "label" column is the
    // human-readable name rather than the membership id. Same join the
    // page does — kept here so an integrator scraping the endpoint
    // gets identical data without a second round-trip.
    const memberIds = rollup.byMembership.map((m) => m.membershipId);
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
      eventType: "DRAFTS_ROLLUP_EXPORTED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        windowDays,
        format: "csv",
        totals: {
          produced: rollup.totals.produced,
          sent: rollup.totals.sent,
        },
      },
    });

    const body = formatDraftsRollupAsCsv(rollup, memberLabels);
    const filename = `drafts-rollup-${slug}-${windowDays}d-${Date.now()}.csv`;
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "/api/admin/drafts/export" } });
  }
}
