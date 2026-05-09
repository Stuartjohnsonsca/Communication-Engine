import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { aggregateClosedMonths, lastClosedPeriods } from "@/lib/adherence/monthly";
import { getDpiaStatus } from "@/lib/dpia/status";

type DimensionKey =
  | "responseTime"
  | "tone"
  | "mandatoryPhrase"
  | "prohibitedPhrase"
  | "escalation";

const DIMENSIONS: { key: DimensionKey; label: string }[] = [
  { key: "responseTime", label: "Response time" },
  { key: "tone", label: "Tone" },
  { key: "mandatoryPhrase", label: "Mandatory phrases" },
  { key: "prohibitedPhrase", label: "Prohibited phrases" },
  { key: "escalation", label: "Escalation handling" },
];

const PERIODS_BACK = 6;

export default async function FctAdherencePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  // Same gate as the audit log: FCT_MEMBER + FIRM_ADMIN.
  if (!hasPermission(ctx.membership.role, "audit:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  // Same gate as the personal dashboard. PRD §12.2 — dashboards are paused
  // when there is no current DPIA, including the firm-wide aggregate view.
  const dpia = await getDpiaStatus(ctx.tenant.id);
  if (!dpia.dashboardsAllowed) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Firm adherence</h1>
          <p className="text-sm text-ink/60">PRD §9.2. Currently paused.</p>
        </div>
        <div className="card border-red-200 bg-red-50/40">
          <div className="text-sm font-medium text-red-800">
            Adherence reporting paused — DPIA {dpia.state === "NEVER" ? "not yet attested" : "expired"}
          </div>
          <p className="mt-1 text-sm text-ink/70">{dpia.banner?.message}</p>
          <p className="mt-2 text-xs text-ink/60">
            Per PRD §12.2 drafting continues; dashboards and Sales Identifier are paused until a
            Firm Administrator re-attests in the{" "}
            <Link href={`/${tenantSlug}/dpia`} className="underline">
              DPIA Helper
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  const periods = lastClosedPeriods(PERIODS_BACK);
  await aggregateClosedMonths(ctx.tenant.id, periods);

  // Firm-wide aggregate is allowed live (no opt-in needed). Use the per-comm
  // rows directly for "this month so far" + last 30 days, since AdherenceScore
  // intentionally never holds a row for the open month.
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [firmRecent, scores, members] = await Promise.all([
    superDb.communicationAdherence.findMany({
      where: { tenantId: ctx.tenant.id, createdAt: { gte: since30 } },
      select: { overall: true },
    }),
    superDb.adherenceScore.findMany({
      where: { tenantId: ctx.tenant.id, period: { in: periods } },
      orderBy: [{ period: "desc" }],
    }),
    superDb.membership.findMany({
      where: { tenantId: ctx.tenant.id, status: "ACTIVE" },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  const firmOverall30 =
    firmRecent.length === 0
      ? null
      : firmRecent.reduce((s, r) => s + r.overall, 0) / firmRecent.length;

  // Group scores by membership for the table.
  const byMember = new Map<string, Map<string, (typeof scores)[number]>>();
  for (const s of scores) {
    if (!byMember.has(s.membershipId)) byMember.set(s.membershipId, new Map());
    byMember.get(s.membershipId)!.set(s.period, s);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Firm adherence</h1>
        <p className="text-sm text-ink/60">
          PRD §9.2 — individual adherence is shown <strong>monthly in arrears</strong> and only
          where the User has opted in. The current month is never shown per-User. Aggregate
          firm-wide numbers are live.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Firm-wide (30d)</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {firmOverall30 == null ? "—" : `${Math.round(firmOverall30 * 100)}%`}
          </div>
          <div className="text-xs text-ink/60">{firmRecent.length} scored sent comms</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Members</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{members.length}</div>
          <div className="text-xs text-ink/60">
            {members.filter((m) => m.perfDashOptIn).length} opted in to per-User reporting
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase tracking-wider text-ink/50">Periods</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{periods.length}</div>
          <div className="text-xs text-ink/60">closed months back from today</div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="text-base font-medium">Per-User · monthly closed periods</h2>
        <p className="mt-1 text-xs text-ink/60">
          Cells show overall adherence and sample size. Members without opt-in show{" "}
          <span className="tag bg-ink/10">opt-in required</span>. Toggle is on each User&rsquo;s
          UCG page.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">User</th>
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Opt-in</th>
              {periods.map((p) => (
                <th key={p} className="py-1 pr-3">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const memberScores = byMember.get(m.id);
              return (
                <tr key={m.id} className="border-t border-ink/5">
                  <td className="py-1 pr-3">{m.user.name ?? m.user.email}</td>
                  <td className="py-1 pr-3">
                    <span className="tag">{m.role}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {m.perfDashOptIn ? (
                      <span className="tag bg-emerald-100 text-emerald-800">opted in</span>
                    ) : (
                      <span className="tag bg-ink/10">opt-in required</span>
                    )}
                  </td>
                  {periods.map((p) => {
                    if (!m.perfDashOptIn) {
                      return (
                        <td key={p} className="py-1 pr-3 text-xs text-ink/40">
                          —
                        </td>
                      );
                    }
                    const s = memberScores?.get(p);
                    if (!s) {
                      return (
                        <td key={p} className="py-1 pr-3 text-xs text-ink/40">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={p} className="py-1 pr-3">
                        <div className="font-medium tabular-nums">
                          {Math.round(s.overall * 100)}%
                        </div>
                        <div className="text-xs text-ink/50">n={s.sampleN}</div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Dimension breakdown · last closed month</h2>
        <DimensionsForLastClosedMonth scores={scores} members={members} />
      </div>

      <div className="card text-xs text-ink/60">
        <Link href={`/${tenantSlug}/dashboards`} className="underline decoration-dotted">
          ← My personal adherence
        </Link>
      </div>
    </div>
  );
}

function DimensionsForLastClosedMonth({
  scores,
  members,
}: {
  scores: { membershipId: string; period: string; payload: unknown; overall: number; sampleN: number }[];
  members: { id: string; perfDashOptIn: boolean; user: { email: string; name: string | null } }[];
}) {
  if (scores.length === 0) {
    return <p className="mt-2 text-sm text-ink/60">No closed-month scores yet.</p>;
  }
  const lastPeriod = scores.reduce((acc, s) => (s.period > acc ? s.period : acc), scores[0].period);
  const optInIds = new Set(members.filter((m) => m.perfDashOptIn).map((m) => m.id));
  const lastScores = scores.filter((s) => s.period === lastPeriod && optInIds.has(s.membershipId));

  if (lastScores.length === 0) {
    return (
      <p className="mt-2 text-sm text-ink/60">
        No opted-in members have scored data for {lastPeriod}.
      </p>
    );
  }

  type DimAgg = { sum: number; n: number; fails: number };
  const dimAgg: Record<DimensionKey, DimAgg> = {
    responseTime: { sum: 0, n: 0, fails: 0 },
    tone: { sum: 0, n: 0, fails: 0 },
    mandatoryPhrase: { sum: 0, n: 0, fails: 0 },
    prohibitedPhrase: { sum: 0, n: 0, fails: 0 },
    escalation: { sum: 0, n: 0, fails: 0 },
  };

  for (const s of lastScores) {
    const p = (s.payload as { perDimension?: Record<DimensionKey, { score?: number | null; n?: number; fails?: number }> })?.perDimension;
    if (!p) continue;
    for (const { key } of DIMENSIONS) {
      const v = p[key];
      if (!v) continue;
      if (typeof v.score === "number" && typeof v.n === "number" && v.n > 0) {
        dimAgg[key].sum += v.score * v.n;
        dimAgg[key].n += v.n;
      }
      if (typeof v.fails === "number") dimAgg[key].fails += v.fails;
    }
  }

  return (
    <div className="mt-2">
      <p className="text-xs text-ink/60">Period {lastPeriod} · opted-in members only</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
                {a.n} sample{a.n === 1 ? "" : "s"}
                {a.fails > 0 && (
                  <span className="text-red-600">
                    {" "}
                    · {a.fails} fail{a.fails === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
