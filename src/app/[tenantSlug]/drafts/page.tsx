import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

export default async function DraftsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const drafts = await superDb.draft.findMany({
    where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    orderBy: { createdAt: "desc" },
    include: { actions: true },
    take: 50,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
        <Link href={`/${tenantSlug}/drafts/new`} className="btn btn-primary">
          New draft
        </Link>
      </div>

      {drafts.length === 0 ? (
        <p className="text-sm text-ink/60">
          No drafts yet. <Link href={`/${tenantSlug}/drafts/new`}>Paste an inbound message</Link> to
          generate one.
        </p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((d) => (
            <li key={d.id} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{d.subject ?? "(no subject)"}</div>
                  <div className="text-xs text-ink/50">
                    {d.kind} · {d.channel} · {d.createdAt.toISOString()}{" "}
                    {d.holdingRequired && <span className="tag bg-amber-100 ml-2">holding</span>}
                    {d.researchTaskRequired && (
                      <span className="tag bg-violet-100 ml-2">research required</span>
                    )}
                  </div>
                </div>
                <span className="tag">{d.status}</span>
              </div>
              <pre className="mt-3 whitespace-pre-wrap rounded bg-ink/5 p-3 text-sm">{d.body}</pre>
              {d.actions.length > 0 && (
                <div className="mt-3">
                  <div className="label">Extracted actions ({d.actions.length})</div>
                  <ul className="space-y-1 text-sm">
                    {d.actions.map((a) => (
                      <li key={a.id} className="flex items-baseline gap-2">
                        <span className="tag">{a.type}</span>
                        <span>{a.title}</span>
                        {a.dueAt && (
                          <span className="text-xs text-ink/50">
                            due {a.dueAt.toISOString().slice(0, 10)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
