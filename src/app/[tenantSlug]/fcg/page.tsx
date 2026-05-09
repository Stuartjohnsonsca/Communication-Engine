import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

export default async function FCGIndex({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const [committed, versions, proposals] = await Promise.all([
    superDb.firmCultureGuide.findFirst({
      where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
      orderBy: { version: "desc" },
      include: { rules: true, _count: { select: { rules: true } } },
    }),
    superDb.firmCultureGuide.findMany({
      where: { tenantId: ctx.tenant.id },
      orderBy: { version: "desc" },
      take: 10,
    }),
    superDb.fCGProposal.findMany({
      where: { tenantId: ctx.tenant.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: {
        _count: { select: { votes: true } },
        proposedBy: { include: { user: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Firm Culture Guide</h1>
        <div className="flex gap-2">
          <Link href={`/${tenantSlug}/fcg/scan`} className="btn btn-primary">
            Scan to draft
          </Link>
          <Link href={`/${tenantSlug}/fcg/wizard`} className="btn">
            Start wizard
          </Link>
          <Link href={`/${tenantSlug}/fcg/chat`} className="btn">
            Free-form chat
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Committed</h2>
          {committed && <span className="tag">v{committed.version} · {committed._count.rules} rules</span>}
        </div>
        {!committed ? (
          <p className="mt-2 text-sm text-ink/60">
            No FCG committed yet. Open <Link href={`/${tenantSlug}/fcg/chat`}>New proposal</Link> to draft v1.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {committed.rules.slice(0, 8).map((r) => (
              <li key={r.id} className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-ink/60">{r.externalId}</span>
                <span className="tag">{r.category}</span>
                <span className="tag">{r.channel}</span>
                <span className="flex-1">{r.statement}</span>
                {r.mandatory && <span className="tag bg-amber-100">mandatory</span>}
              </li>
            ))}
            {committed.rules.length > 8 && (
              <li className="text-xs text-ink/50">… {committed.rules.length - 8} more</li>
            )}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Proposals</h2>
        {proposals.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">None yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink/5 text-sm">
            {proposals.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/${tenantSlug}/fcg/proposals/${p.id}`}
                  className="flex items-center justify-between gap-3 rounded py-2 px-2 -mx-2 hover:bg-ink/5"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-ink/50">
                      {p.proposedBy.user.email} · {p._count.votes} vote{p._count.votes === 1 ? "" : "s"}
                      {p.votingClosesAt && ` · closes ${p.votingClosesAt.toISOString().slice(0, 10)}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="tag">{p.state}</span>
                    <span className="text-ink/40" aria-hidden>→</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Version history</h2>
        {versions.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">No versions yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink/5 text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between py-2">
                <span>
                  v{v.version} <span className="tag">{v.status}</span>
                </span>
                <span className="text-xs text-ink/50">{v.createdAt.toISOString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
