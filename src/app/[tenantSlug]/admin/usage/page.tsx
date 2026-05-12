import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import {
  estimateCostMinor,
  aggregateFailures,
  type FailedCallRow,
} from "@/lib/ai/usage";

/**
 * Post-PRD hardening item 55 — per-tenant LLM usage observability.
 *
 * One page per tenant; FIRM_ADMIN only. Renders a 30-day rollup of
 * every recorded LLM call: total tokens by `role` and by `context`,
 * top spending Memberships, and an estimated cost in the tenant's
 * pricing currency. Cost is computed on read from a per-model rate
 * table — historic rows under new rates is fine for capacity
 * planning; accounting-grade billing is a future item.
 */

type GroupRow = {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMinor: number;
  calls: number;
};

function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  const fmt = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  });
  return fmt.format(major);
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export default async function UsagePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "usage:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const windowDays = 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // One pull, group in app code. At ~100s-1000s of rows / month per
  // tenant the cost is fine; if a tenant ever burns >100k LLM calls in
  // 30d we can move this to a server-side aggregation query.
  const rows = await superDb.llmCall.findMany({
    where: { tenantId: ctx.tenant.id, createdAt: { gte: since } },
    select: {
      id: true,
      role: true,
      context: true,
      model: true,
      provider: true,
      membershipId: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      succeeded: true,
      errorMessage: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const byRole = new Map<string, GroupRow>();
  const byContext = new Map<string, GroupRow>();
  const byMembership = new Map<string, GroupRow>();
  const byModel = new Map<string, GroupRow>();
  let totalCalls = 0;
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let failed = 0;

  for (const r of rows) {
    totalCalls += 1;
    if (!r.succeeded) failed += 1;
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;
    const cost = estimateCostMinor({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
    });
    totalCost += cost;

    function bump(map: Map<string, GroupRow>, key: string) {
      const existing = map.get(key) ?? {
        key,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costMinor: 0,
        calls: 0,
      };
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.cacheReadTokens += r.cacheReadTokens;
      existing.cacheCreationTokens += r.cacheCreationTokens;
      existing.costMinor += cost;
      existing.calls += 1;
      map.set(key, existing);
    }
    bump(byRole, r.role);
    bump(byContext, r.context);
    bump(byModel, r.model);
    bump(byMembership, r.membershipId ?? "system");
  }

  // Item 60 — recent failures + grouped failure modes.
  const failureRows: FailedCallRow[] = rows
    .filter((r) => !r.succeeded)
    .map((r) => ({
      id: r.id,
      role: r.role,
      context: r.context,
      model: r.model,
      provider: r.provider,
      membershipId: r.membershipId ?? null,
      errorMessage: r.errorMessage ?? null,
      createdAt: r.createdAt,
    }));
  const failureAggregate = aggregateFailures(failureRows);

  // Membership labels for the top-5 spenders + every recent-failure
  // membership so the failures table shows names rather than ids.
  const topMembershipIds = Array.from(byMembership.entries())
    .filter(([k]) => k !== "system")
    .sort((a, b) => b[1].costMinor - a[1].costMinor)
    .slice(0, 5)
    .map(([k]) => k);
  const failureMembershipIds = failureAggregate.recent
    .map((r) => r.membershipId)
    .filter((id): id is string => id !== null);
  const allMembershipIds = Array.from(
    new Set([...topMembershipIds, ...failureMembershipIds]),
  );
  const memberships = allMembershipIds.length
    ? await superDb.membership.findMany({
        where: { id: { in: allMembershipIds } },
        include: { user: { select: { email: true, name: true } } },
      })
    : [];
  const membershipLabel = new Map<string, string>(
    memberships.map((m) => [m.id, m.user.name ?? m.user.email ?? m.id]),
  );

  const currency = ctx.tenant.pricingCurrency || "GBP";

  const sortedRoles = Array.from(byRole.values()).sort(
    (a, b) => b.costMinor - a.costMinor,
  );
  const sortedContexts = Array.from(byContext.values()).sort(
    (a, b) => b.costMinor - a.costMinor,
  );
  const sortedModels = Array.from(byModel.values()).sort(
    (a, b) => b.costMinor - a.costMinor,
  );

  return (
    <main className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">LLM usage</h1>
          <p className="text-sm text-ink/60">
            Last {windowDays} days. Tokens recorded per call by{" "}
            <code className="text-xs">src/lib/ai/client.ts</code>; cost is computed on read from
            a per-model rate table and is an estimate, not a billing-grade figure.
          </p>
        </div>
        <a
          href={`/api/admin/usage/export?tenant=${tenantSlug}&window=${windowDays}`}
          className="rounded border border-ink/20 px-2 py-1 text-sm hover:bg-ink/5"
        >
          Download CSV
        </a>
      </header>

      <div className="card grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Field label="Total calls" value={String(totalCalls)} />
        <Field label="Failed" value={failed > 0 ? String(failed) : "—"} />
        <Field label="Input tokens" value={formatTokens(totalInput)} />
        <Field label="Output tokens" value={formatTokens(totalOutput)} />
        <Field label="Estimated cost" value={formatMoney(totalCost, currency)} />
      </div>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">By agent role</h2>
        <p className="text-xs text-ink/60">
          Which agents are burning the most? `draft` typically dominates auto-mode tenants;
          `adherence` and `sentiment` scale with send + inbound volume.
        </p>
        <GroupTable rows={sortedRoles} currency={currency} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">By context</h2>
        <p className="text-xs text-ink/60">
          Distinguishes cron from User-initiated spend.{" "}
          <code className="text-xs">auto-draft</code> is the 5-minute cron;{" "}
          <code className="text-xs">manual-draft</code> is User-pasted via the UI;{" "}
          <code className="text-xs">draft-regenerate</code> is the regenerate button;{" "}
          <code className="text-xs">sentiment-classify</code> + adherence ones run alongside.
        </p>
        <GroupTable rows={sortedContexts} currency={currency} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">By model</h2>
        <p className="text-xs text-ink/60">
          Each agent role binds to a provider + model via{" "}
          <code className="text-xs">LLM_*</code> env overrides; the table shows what actually
          executed. Mixed providers in one role usually means an env override was applied
          mid-window.
        </p>
        <GroupTable rows={sortedModels} currency={currency} keyLabel="Model" />
      </section>

      {topMembershipIds.length > 0 && (
        <section className="card space-y-3">
          <h2 className="text-base font-medium">Top spending Memberships</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3">Calls</th>
                <th className="py-1 pr-3">Input</th>
                <th className="py-1 pr-3">Output</th>
                <th className="py-1 pr-3">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {topMembershipIds.map((id) => {
                const r = byMembership.get(id)!;
                return (
                  <tr key={id} className="border-t border-ink/5">
                    <td className="py-2 pr-3">{membershipLabel.get(id) ?? id}</td>
                    <td className="py-2 pr-3">{r.calls}</td>
                    <td className="py-2 pr-3">{formatTokens(r.inputTokens)}</td>
                    <td className="py-2 pr-3">{formatTokens(r.outputTokens)}</td>
                    <td className="py-2 pr-3 font-medium">
                      {formatMoney(r.costMinor, currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {failureAggregate.totalFailures > 0 && (
        <section className="card border-red-200 bg-red-50/30 space-y-3">
          <div>
            <h2 className="text-base font-medium text-red-900">
              Recent failures ({failureAggregate.totalFailures})
            </h2>
            <p className="text-xs text-red-900/70">
              Failed LLM calls in the last {windowDays} days. Grouped by error
              message prefix. The auto-draft circuit breaker (
              <code className="text-xs">/admin/channels</code>) pauses the
              tenant after 5 such failures in 30 minutes for the
              <code className="mx-1">auto-draft</code>context — check these
              rows first when investigating a circuit-breaker trip.
            </p>
          </div>

          {failureAggregate.byMessage.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
                <tr>
                  <th className="py-1 pr-3">Message</th>
                  <th className="py-1 pr-3">Count</th>
                  <th className="py-1 pr-3">Contexts</th>
                  <th className="py-1 pr-3">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {failureAggregate.byMessage.slice(0, 10).map((g) => (
                  <tr key={g.normalisedMessage} className="border-t border-ink/5 align-top">
                    <td className="py-2 pr-3 max-w-[40ch]">
                      <code className="text-xs break-words">
                        {g.exemplarMessage}
                      </code>
                    </td>
                    <td className="py-2 pr-3 font-medium tabular-nums">{g.count}</td>
                    <td className="py-2 pr-3 text-xs">
                      {Array.from(g.contexts).map((c) => (
                        <span key={c} className="tag bg-ink/[0.04] mr-1">
                          <code className="text-[10px]">{c}</code>
                        </span>
                      ))}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink/60">
                      {g.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div>
            <h3 className="text-xs uppercase tracking-wider text-ink/50">
              Last {Math.min(failureAggregate.recent.length, 20)} failed calls
            </h3>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
                <tr>
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Role</th>
                  <th className="py-1 pr-3">Context</th>
                  <th className="py-1 pr-3">Model</th>
                  <th className="py-1 pr-3">Member</th>
                  <th className="py-1 pr-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {failureAggregate.recent.map((r) => (
                  <tr key={r.id} className="border-t border-ink/5 align-top">
                    <td className="py-2 pr-3 text-xs text-ink/60">
                      {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <code>{r.role}</code>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <code>{r.context}</code>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <code>{r.model}</code>
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink/70">
                      {r.membershipId
                        ? (membershipLabel.get(r.membershipId) ?? r.membershipId)
                        : "system"}
                    </td>
                    <td className="py-2 pr-3 text-xs max-w-[40ch]">
                      <code className="break-words text-red-900">
                        {r.errorMessage ?? "(no message)"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {totalCalls === 0 && (
        <p className="text-sm text-ink/60">
          No LLM calls recorded yet for this tenant in the last {windowDays} days. Drafting,
          classification, and adherence scoring all leave rows here once they execute.
        </p>
      )}
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink/60 text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function GroupTable({
  rows,
  currency,
  keyLabel = "Key",
}: {
  rows: GroupRow[];
  currency: string;
  keyLabel?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-ink/60">No activity.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
        <tr>
          <th className="py-1 pr-3">{keyLabel}</th>
          <th className="py-1 pr-3">Calls</th>
          <th className="py-1 pr-3">Input</th>
          <th className="py-1 pr-3">Output</th>
          <th className="py-1 pr-3">Cache read</th>
          <th className="py-1 pr-3">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-ink/5">
            <td className="py-2 pr-3 font-medium">
              <code className="text-xs">{r.key}</code>
            </td>
            <td className="py-2 pr-3">{r.calls}</td>
            <td className="py-2 pr-3">{formatTokens(r.inputTokens)}</td>
            <td className="py-2 pr-3">{formatTokens(r.outputTokens)}</td>
            <td className="py-2 pr-3 text-ink/60">{formatTokens(r.cacheReadTokens)}</td>
            <td className="py-2 pr-3 font-medium">{formatMoney(r.costMinor, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
