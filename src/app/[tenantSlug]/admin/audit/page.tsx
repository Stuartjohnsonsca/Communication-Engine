import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "audit:read")) {
    return <p className="text-sm text-ink/60">You don&apos;t have permission to view the audit log.</p>;
  }

  const events = await superDb.auditEvent.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { seq: "desc" },
    take: 200,
    include: { actor: { include: { user: true } } },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        {hasPermission(ctx.membership.role, "audit:export") && (
          <Link
            className="btn btn-primary"
            href={`/api/audit/export?tenant=${tenantSlug}`}
            prefetch={false}
          >
            Export NDJSON
          </Link>
        )}
      </div>
      <p className="text-xs text-ink/60">
        Append-only. Hash-chained per tenant. Showing the most recent 200 events.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">When</th>
              <th className="py-1 pr-3">Event</th>
              <th className="py-1 pr-3">Subject</th>
              <th className="py-1 pr-3">Actor</th>
              <th className="py-1 pr-3">Hash</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-ink/5">
                <td className="py-1 pr-3 font-mono text-xs">{e.seq.toString()}</td>
                <td className="py-1 pr-3 text-xs">{e.createdAt.toISOString()}</td>
                <td className="py-1 pr-3">{e.eventType}</td>
                <td className="py-1 pr-3 text-xs">
                  {e.subjectType} <span className="font-mono text-ink/50">{e.subjectId.slice(0, 6)}</span>
                </td>
                <td className="py-1 pr-3 text-xs">{e.actor?.user.email ?? "—"}</td>
                <td className="py-1 pr-3 font-mono text-[10px] text-ink/50">{e.hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
