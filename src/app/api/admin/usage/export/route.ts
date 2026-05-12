import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import { estimateCostMinor } from "@/lib/ai/usage";
import {
  formatUsageRollupAsCsv,
  type UsageCsvRow,
} from "@/lib/ai/usage-csv";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 70 — CSV export of the /admin/usage cost
 * rollup. Companion to item 68 (drafts rollup CSV); same pattern.
 *
 * RBAC `usage:read` is FIRM_ADMIN only — this surfaces commercial
 * data so FCT_MEMBER is excluded (matches the page gate).
 *
 * The aggregation mirrors the page's inline logic; we don't refactor
 * the page to avoid risking the shipped UI. If a third surface ever
 * needs it, factor `aggregateUsageRows` then.
 */

type GroupRow = {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMinor: number;
};

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

function parseWindow(raw: string | null): Window {
  const n = Number(raw);
  if (WINDOWS.includes(n as Window)) return n as Window;
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
    requirePermission(ctx.membership.role, "usage:read");

    const windowDays = parseWindow(url.searchParams.get("window"));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await superDb.llmCall.findMany({
      where: { tenantId: ctx.tenant.id, createdAt: { gte: since } },
      select: {
        role: true,
        context: true,
        model: true,
        membershipId: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheCreationTokens: true,
      },
    });

    const byRole = new Map<string, GroupRow>();
    const byContext = new Map<string, GroupRow>();
    const byModel = new Map<string, GroupRow>();
    const byMembership = new Map<string, GroupRow>();
    let totals: GroupRow = {
      key: "totals",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costMinor: 0,
    };

    function bump(map: Map<string, GroupRow>, key: string, r: (typeof rows)[number], cost: number) {
      const existing = map.get(key) ?? {
        key,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costMinor: 0,
      };
      existing.calls += 1;
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.cacheReadTokens += r.cacheReadTokens;
      existing.cacheCreationTokens += r.cacheCreationTokens;
      existing.costMinor += cost;
      map.set(key, existing);
    }

    for (const r of rows) {
      const cost = estimateCostMinor({
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
      });
      totals.calls += 1;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cacheReadTokens += r.cacheReadTokens;
      totals.cacheCreationTokens += r.cacheCreationTokens;
      totals.costMinor += cost;
      bump(byRole, r.role, r, cost);
      bump(byContext, r.context, r, cost);
      bump(byModel, r.model, r, cost);
      // `null` membership (system / cron) is bucketed as a literal
      // "system" key so it's visible rather than dropped — auditors
      // care that the cron is or isn't burning the cost.
      bump(byMembership, r.membershipId ?? "system", r, cost);
    }

    const memberIds = Array.from(byMembership.keys()).filter(
      (k) => k !== "system",
    );
    const memberships = memberIds.length
      ? await superDb.membership.findMany({
          where: { id: { in: memberIds } },
          include: { user: { select: { email: true, name: true } } },
        })
      : [];
    const memberLabel = new Map<string, string>(
      memberships.map((m) => [m.id, m.user.name ?? m.user.email ?? m.id]),
    );

    const currency = ctx.tenant.pricingCurrency || "GBP";

    // Sort each group by cost desc — same order the page renders, so
    // the CSV reads identically without an extra sort step.
    const toCsvRow = (
      scopePrefix: string,
      labelFor: (key: string) => string,
      group: Map<string, GroupRow>,
    ): UsageCsvRow[] =>
      Array.from(group.values())
        .sort((a, b) => b.costMinor - a.costMinor)
        .map((r) => ({
          scope: `${scopePrefix}:${r.key}`,
          label: labelFor(r.key),
          calls: r.calls,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheCreationTokens: r.cacheCreationTokens,
          costMinor: r.costMinor,
        }));

    const csv = formatUsageRollupAsCsv({
      windowDays,
      currency,
      totals: { ...totals, scope: "totals", label: `Totals (${windowDays}d)` },
      byRole: toCsvRow("role", (k) => k, byRole),
      byContext: toCsvRow("context", (k) => k, byContext),
      byModel: toCsvRow("model", (k) => k, byModel),
      byMembership: toCsvRow(
        "membership",
        (k) => (k === "system" ? "system (cron)" : memberLabel.get(k) ?? k),
        byMembership,
      ),
    });

    await writeAuditEvent({
      tenantId: ctx.tenant.id,
      eventType: "USAGE_ROLLUP_EXPORTED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        windowDays,
        format: "csv",
        currency,
        totals: { calls: totals.calls, costMinor: totals.costMinor },
      },
    });

    const filename = `usage-${slug}-${windowDays}d-${Date.now()}.csv`;
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "/api/admin/usage/export" } });
  }
}
