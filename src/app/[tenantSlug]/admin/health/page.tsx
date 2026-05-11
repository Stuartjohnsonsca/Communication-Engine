import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { evaluateCronHealth, type CronStatus } from "@/lib/cron-health";

const STATE_PILL: Record<CronStatus["state"], string> = {
  ok: "bg-emerald-100 text-emerald-800",
  stalled: "bg-red-100 text-red-800",
  failing: "bg-amber-100 text-amber-900",
  "never-run": "bg-ink/10 text-ink/60",
};

const STATE_LABEL: Record<CronStatus["state"], string> = {
  ok: "OK",
  stalled: "Stalled",
  failing: "Failing",
  "never-run": "Never run",
};

export default async function SystemHealthPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "system:cron-health:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }
  // Acumon-side surface — cron schedules are platform-wide, not per-tenant.
  // Even FIRM_ADMINs of other tenants can't view operator infrastructure.
  if (ctx.tenant.slug !== "acumon") {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const statuses = await evaluateCronHealth();
  const stalledCount = statuses.filter((s) => s.state === "stalled" || s.state === "failing").length;

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Platform cron health</h1>
        <p className="text-sm text-ink/60">
          One row per registered cron. Updated by <code className="text-xs">withCronHeartbeat</code> on
          every run; evaluated periodically by <code className="text-xs">/api/cron/health-check</code>{" "}
          which writes <code className="text-xs">CRON_STALLED</code> audit events + immediate
          notifications when a cron drifts past 2× its expected interval.
        </p>
      </header>

      <div className="card flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-ink/60">Total crons:</span>{" "}
          <span className="font-medium">{statuses.length}</span>
        </div>
        <div>
          <span className="text-ink/60">Healthy:</span>{" "}
          <span className="font-medium text-emerald-700">
            {statuses.filter((s) => s.state === "ok").length}
          </span>
        </div>
        <div>
          <span className="text-ink/60">Attention required:</span>{" "}
          <span className={`font-medium ${stalledCount > 0 ? "text-red-700" : "text-ink"}`}>
            {stalledCount}
          </span>
        </div>
      </div>

      <div className="space-y-3">
        {statuses.map((s) => (
          <article key={s.cronName} className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <code className="text-sm font-semibold">{s.cronName}</code>
                  <span className={`tag ${STATE_PILL[s.state]}`}>{STATE_LABEL[s.state]}</span>
                </div>
                <p className="text-xs text-ink/60">{s.description}</p>
              </div>
              <div className="text-xs text-ink/60">
                expected every <span className="font-medium text-ink">{formatInterval(s.expectedIntervalMinutes)}</span>
              </div>
            </div>

            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Last run" value={formatTs(s.lastRunAt)} />
              <Field label="Last success" value={formatTs(s.lastSuccessAt)} />
              <Field label="Last failure" value={formatTs(s.lastFailureAt)} />
              <Field
                label="Consecutive failures"
                value={s.consecutiveFailures > 0 ? String(s.consecutiveFailures) : "—"}
              />
              {s.lastDurationMs !== null && (
                <Field label="Last duration" value={`${s.lastDurationMs}ms`} />
              )}
              {s.stalledNotifiedAt && (
                <Field label="Stall alert last sent" value={formatTs(s.stalledNotifiedAt)} />
              )}
            </dl>

            {s.lastErrorMessage && (
              <div className="rounded border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-900">
                <div className="font-medium">Last error:</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{s.lastErrorMessage}</pre>
              </div>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink/60">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function formatTs(d: Date | null): string {
  if (!d) return "—";
  const iso = d.toISOString();
  return iso.slice(0, 19).replace("T", " ") + " UTC";
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (24 * 60))} d`;
}
