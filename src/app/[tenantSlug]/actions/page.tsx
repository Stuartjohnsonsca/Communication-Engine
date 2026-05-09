import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import ActionsClient, { type ActionRow, type StatusFilter } from "./ActionsClient";

const STATUS_FILTERS: StatusFilter[] = ["OPEN", "COMPLETED", "DISMISSED", "ALL"];

function parseFilter(value: string | undefined): StatusFilter {
  if (value && (STATUS_FILTERS as string[]).includes(value)) return value as StatusFilter;
  return "OPEN";
}

export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { tenantSlug } = await params;
  const { status } = await searchParams;
  const filter = parseFilter(status);

  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const where = {
    tenantId: ctx.tenant.id,
    membershipId: ctx.membership.id,
    ...(filter === "ALL" ? {} : { status: filter }),
  };

  const [actions, counts] = await Promise.all([
    superDb.action.findMany({
      where,
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
      take: 200,
      include: { draft: { select: { id: true, subject: true } } },
    }),
    superDb.action.groupBy({
      by: ["status"],
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      _count: { _all: true },
    }),
  ]);

  const countMap: Record<string, number> = {};
  for (const c of counts) countMap[c.status] = c._count._all;
  const totals = {
    OPEN: countMap.OPEN ?? 0,
    COMPLETED: countMap.COMPLETED ?? 0,
    DISMISSED: countMap.DISMISSED ?? 0,
    ALL: Object.values(countMap).reduce((a, b) => a + b, 0),
  };

  const rows: ActionRow[] = actions.map((a) => ({
    id: a.id,
    title: a.title,
    detail: a.detail,
    type: a.type,
    status: a.status,
    dueAt: a.dueAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
    draft: a.draft ? { id: a.draft.id, subject: a.draft.subject } : null,
  }));

  return (
    <ActionsClient
      tenantSlug={tenantSlug}
      filter={filter}
      totals={totals}
      actions={rows}
    />
  );
}
