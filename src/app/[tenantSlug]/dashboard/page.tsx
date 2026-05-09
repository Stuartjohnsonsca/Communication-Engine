import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

export default async function Dashboard({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const [committedFcg, openProposals, myUcg, recentDrafts, recentEvents] = await Promise.all([
    superDb.firmCultureGuide.findFirst({
      where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
      orderBy: { version: "desc" },
      include: { _count: { select: { rules: true } } },
    }),
    superDb.fCGProposal.count({
      where: { tenantId: ctx.tenant.id, state: "OPEN_FOR_VOTE" },
    }),
    superDb.userCultureGuide.findFirst({
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      orderBy: { version: "desc" },
    }),
    superDb.draft.findMany({
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    superDb.auditEvent.findMany({
      where: { tenantId: ctx.tenant.id },
      orderBy: { seq: "desc" },
      take: 10,
    }),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Committed FCG</div>
          <div className="mt-1 text-2xl font-medium">
            {committedFcg ? `v${committedFcg.version}` : "none yet"}
          </div>
          <div className="text-xs text-ink/60">
            {committedFcg ? `${committedFcg._count.rules} rules` : "Draft and commit one to begin."}
          </div>
          <Link href={`/${tenantSlug}/fcg`} className="btn mt-3 inline-flex">
            Open FCG
          </Link>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Open proposals</div>
          <div className="mt-1 text-2xl font-medium">{openProposals}</div>
          <Link href={`/${tenantSlug}/fcg`} className="btn mt-3 inline-flex">
            Review &amp; vote
          </Link>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">My UCG</div>
          <div className="mt-1 text-2xl font-medium">
            {myUcg ? myUcg.status : "not started"}
          </div>
          <Link href={`/${tenantSlug}/ucg`} className="btn mt-3 inline-flex">
            Open UCG
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Recent drafts</h2>
          <Link href={`/${tenantSlug}/drafts/new`} className="btn btn-primary">
            New draft
          </Link>
        </div>
        {recentDrafts.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">
            No drafts yet — paste an inbound message in <Link href={`/${tenantSlug}/drafts/new`}>New draft</Link>.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {recentDrafts.map((d) => (
              <li key={d.id} className="flex items-center justify-between">
                <Link href={`/${tenantSlug}/drafts`}>{d.subject ?? d.body.slice(0, 70)}</Link>
                <span className="tag">{d.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Recent audit events</h2>
        <ul className="mt-3 divide-y divide-ink/5 text-sm">
          {recentEvents.length === 0 ? (
            <li className="py-2 text-ink/60">None yet.</li>
          ) : (
            recentEvents.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between py-2">
                <div>
                  <span className="font-mono text-xs text-ink/60">#{e.seq.toString()}</span>{" "}
                  <span className="font-medium">{e.eventType}</span>{" "}
                  <span className="text-ink/60">{e.subjectType}</span>
                </div>
                <div className="text-xs text-ink/50">{e.createdAt.toISOString()}</div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
