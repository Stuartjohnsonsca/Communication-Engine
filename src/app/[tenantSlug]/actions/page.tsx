import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

export default async function ActionsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const actions = await superDb.action.findMany({
    where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
      {actions.length === 0 ? (
        <p className="text-sm text-ink/60">No actions yet. They&apos;re extracted from drafts.</p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="card flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{a.title}</div>
                {a.detail && <div className="text-xs text-ink/60">{a.detail}</div>}
                <div className="text-xs text-ink/50">
                  <span className="tag">{a.type}</span>{" "}
                  {a.dueAt && <>due {a.dueAt.toISOString().slice(0, 10)} · </>}
                  {a.createdAt.toISOString().slice(0, 10)}
                </div>
              </div>
              <span className="tag">{a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
