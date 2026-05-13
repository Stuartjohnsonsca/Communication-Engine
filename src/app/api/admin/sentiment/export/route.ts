import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  getAllSentimentResponses,
  formatSentimentResponsesAsCsv,
} from "@/lib/sentiment/responses-export";
import type { SentimentMetricsWindow } from "@/lib/sentiment/metrics";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 83 — uncapped per-signal CSV export of
 * sentiment responses (acknowledged + open-overdue escalations in the
 * selected window).
 *
 * Sister endpoint to /api/admin/drafts/misses-export (item 76): same
 * RBAC posture (governance not commercial — `sentiment:export` is
 * FIRM_ADMIN + FCT_MEMBER), same audit-on-export pattern, same
 * bogus-window-snaps-to-30 behaviour as the drafts exporters
 * (items 68 / 76). The /sentiment page is firm-wide for FCT/Admin
 * (item 78); the export is firm-wide for the same callers — it's a
 * compliance-grade artefact, not a self-view.
 */

const WINDOWS = [7, 30, 90] as const;

function parseWindow(raw: string | null): SentimentMetricsWindow {
  const n = Number(raw);
  if (WINDOWS.includes(n as SentimentMetricsWindow)) {
    return n as SentimentMetricsWindow;
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
    requirePermission(ctx.membership.role, "sentiment:export");

    const windowDays = parseWindow(url.searchParams.get("window"));
    const responses = await getAllSentimentResponses({
      tenantId: ctx.tenant.id,
      windowDays,
    });

    // Resolve member labels in one query, union of all assignee +
    // acknowledger ids across both buckets — same pattern as item 76.
    // A member appearing only as an acknowledger still gets a human
    // name in the CSV.
    const memberIdSet = new Set<string>();
    for (const r of responses.acknowledged) {
      if (r.assignedToMembershipId) memberIdSet.add(r.assignedToMembershipId);
      if (r.acknowledgedByMembershipId) {
        memberIdSet.add(r.acknowledgedByMembershipId);
      }
    }
    for (const r of responses.openOverdue) {
      if (r.assignedToMembershipId) memberIdSet.add(r.assignedToMembershipId);
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
      eventType: "SENTIMENT_RESPONSES_EXPORTED",
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

    const body = formatSentimentResponsesAsCsv(responses, memberLabels);
    const filename = `sentiment-responses-${slug}-${windowDays}d-${Date.now()}.csv`;
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return safeApiError(err, {
      ctx: { route: "/api/admin/sentiment/export" },
    });
  }
}
