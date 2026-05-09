import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import PerfOptInToggle from "./PerfOptInToggle";

type DimensionKey =
  | "responseTime"
  | "tone"
  | "mandatoryPhrase"
  | "prohibitedPhrase"
  | "escalation";

type Dimension = {
  score: number | null;
  verdict: "pass" | "partial" | "fail" | "not_applicable";
  evidence?: string;
};

const DIMENSIONS: { key: DimensionKey; label: string }[] = [
  { key: "responseTime", label: "Response time" },
  { key: "tone", label: "Tone" },
  { key: "mandatoryPhrase", label: "Mandatory phrases" },
  { key: "prohibitedPhrase", label: "Prohibited phrases" },
  { key: "escalation", label: "Escalation handling" },
];

const VERDICT_BG: Record<Dimension["verdict"], string> = {
  pass: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  fail: "bg-red-100 text-red-700",
  not_applicable: "bg-ink/10 text-ink/60",
};

export default async function PersonalDashboardPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [recent, total30, sentTotal30] = await Promise.all([
    superDb.communicationAdherence.findMany({
      where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        draft: {
          select: {
            id: true,
            subject: true,
            channel: true,
            sentMarkedAt: true,
          },
        },
      },
    }),
    superDb.communicationAdherence.findMany({
      where: {
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
        createdAt: { gte: since30 },
      },
      select: { overall: true, perDimension: true },
    }),
    superDb.draft.count({
      where: {
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
        status: "SENT",
        sentMarkedAt: { gte: since30 },
      },
    }),
  ]);

  const overall30 =
    total30.length === 0
      ? null
      : total30.reduce((s, r) => s + r.overall, 0) / total30.length;

  // Per-dimension averages over the rolling window.
  const dimAgg: Record<DimensionKey, { sum: number; n: number; fails: number }> = {
    responseTime: { sum: 0, n: 0, fails: 0 },
    tone: { sum: 0, n: 0, fails: 0 },
    mandatoryPhrase: { sum: 0, n: 0, fails: 0 },
    prohibitedPhrase: { sum: 0, n: 0, fails: 0 },
    escalation: { sum: 0, n: 0, fails: 0 },
  };
  for (const row of total30) {
    const d = row.perDimension as Record<DimensionKey, Dimension>;
    for (const { key } of DIMENSIONS) {
      const v = d[key];
      if (!v) continue;
      if (typeof v.score === "number") {
        dimAgg[key].sum += v.score;
        dimAgg[key].n += 1;
      }
      if (v.verdict === "fail") dimAgg[key].fails += 1;
    }
  }

  const unscored = sentTotal30 - total30.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My adherence</h1>
        <p className="text-sm text-ink/60">
          Scored against what you actually sent (PRD §9.1), not the system&rsquo;s draft. Rolling
          last 30 days.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Overall (30d)</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {overall30 == null ? "—" : `${Math.round(overall30 * 100)}%`}
          </div>
          <div className="text-xs text-ink/60">
            {total30.length} scored communication{total30.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Sent (30d)</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{sentTotal30}</div>
          <div className="text-xs text-ink/60">
            {unscored > 0 ? `${unscored} not scored` : "all scored"}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Drill-down</div>
          <div className="mt-2 text-sm text-ink/70">
            Each scored item below links back to the draft so you can review the FCG / UCG findings
            in context.
          </div>
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Per-dimension (rolling 30d)</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {DIMENSIONS.map(({ key, label }) => {
            const a = dimAgg[key];
            const avg = a.n === 0 ? null : a.sum / a.n;
            return (
              <div key={key} className="rounded border border-ink/10 p-2">
                <div className="text-xs font-medium">{label}</div>
                <div className="mt-1 text-2xl tabular-nums">
                  {avg == null ? <span className="text-ink/40">—</span> : `${Math.round(avg * 100)}%`}
                </div>
                <div className="text-xs text-ink/60">
                  {a.n} scored
                  {a.fails > 0 && (
                    <span className="text-red-600"> · {a.fails} fail{a.fails === 1 ? "" : "s"}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <PerfOptInToggle tenantSlug={tenantSlug} initial={ctx.membership.perfDashOptIn} />

      <div className="card space-y-2">
        <h2 className="text-base font-medium">Recent scored communications</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-ink/60">
            Nothing scored yet. Mark a draft as sent in <Link href={`/${tenantSlug}/drafts`}>Drafts</Link>
            {" "}to see it here.
          </p>
        ) : (
          <ul className="divide-y divide-ink/5 text-sm">
            {recent.map((row) => {
              const dim = row.perDimension as Record<DimensionKey, Dimension>;
              return (
                <li key={row.id} className="py-2">
                  <Link
                    href={`/${tenantSlug}/drafts/${row.draft.id}`}
                    className="flex items-baseline justify-between gap-3 hover:bg-ink/[0.02]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {row.draft.subject ?? "(no subject)"}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-ink/60">
                        <span className="tag">{row.draft.channel}</span>
                        {DIMENSIONS.map(({ key }) => {
                          const d = dim[key];
                          if (!d || d.verdict === "not_applicable") return null;
                          return (
                            <span key={key} className={`tag ${VERDICT_BG[d.verdict]}`}>
                              {key}:{d.verdict}
                            </span>
                          );
                        })}
                        <span>
                          {row.draft.sentMarkedAt
                            ? row.draft.sentMarkedAt.toISOString().slice(0, 16).replace("T", " ")
                            : row.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-lg font-semibold tabular-nums">
                        {Math.round(row.overall * 100)}%
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
