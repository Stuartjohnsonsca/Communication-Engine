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
    include: { _count: { select: { actions: true } } },
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
        <ul className="space-y-2">
          {drafts.map((d) => {
            const preview = d.body.slice(0, 180).replace(/\s+/g, " ");
            return (
              <li key={d.id}>
                <Link
                  href={`/${tenantSlug}/drafts/${d.id}`}
                  className="card block hover:bg-ink/[0.02]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {d.subject ?? "(no subject)"}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
                        <span className="tag">{d.kind}</span>
                        <span className="tag">{d.channel}</span>
                        {d.holdingRequired && (
                          <span className="tag bg-amber-100">holding</span>
                        )}
                        {d.researchTaskRequired && (
                          <span className="tag bg-violet-100">research required</span>
                        )}
                        {d.noGoSubjectHit && (
                          <span className="tag bg-red-100">no-go subject</span>
                        )}
                        <span>{d.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                        {d._count.actions > 0 && (
                          <span>· {d._count.actions} actions</span>
                        )}
                      </div>
                      <div className="mt-2 truncate text-xs text-ink/60">{preview}</div>
                    </div>
                    <span className="tag shrink-0">{d.status}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
