import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  OUTCOME_LABELS,
  SLA_KIND_LABELS,
  computeLatencyMeasurements,
  getAdherenceKpis,
  getSlaView,
  isAcumonSlaOperator,
  recordSlaMeasurement,
  setSlaTargetThreshold,
} from "@/lib/sla";

export default async function SlaPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "sla:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getSlaView(ctx.tenant.id);
  const latestPeriod = currentPeriod();
  const kpis = await getAdherenceKpis(ctx.tenant.id, latestPeriod);
  const canManage = hasPermission(ctx.membership.role, "sla:manage");
  const isOperator =
    isAcumonSlaOperator(ctx.tenant.slug) &&
    hasPermission(ctx.membership.role, "sla:manage");

  async function recordAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "sla:manage")) throw new Error("forbidden");
    const observedRaw = String(formData.get("observed") ?? "").trim();
    await recordSlaMeasurement({
      tenantId: inner.tenant.id,
      targetCode: String(formData.get("targetCode") ?? ""),
      period: String(formData.get("period") ?? ""),
      observed: observedRaw === "" ? null : Number(observedRaw),
      sampleN: Number(formData.get("sampleN") ?? 0),
      note: String(formData.get("note") ?? "").trim() || null,
      recordedByName: String(formData.get("recordedByName") ?? ""),
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/sla`);
  }

  async function autoComputeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "sla:manage")) throw new Error("forbidden");
    await computeLatencyMeasurements(
      inner.tenant.id,
      String(formData.get("period") ?? ""),
      String(formData.get("recordedByName") ?? ""),
      inner.membership.id,
    );
    revalidatePath(`/${tenantSlug}/sla`);
  }

  async function targetAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonSlaOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "sla:manage")
    ) {
      throw new Error("forbidden");
    }
    await setSlaTargetThreshold({
      code: String(formData.get("code") ?? ""),
      threshold: Number(formData.get("threshold") ?? 0),
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/sla`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Service Levels</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §13.1 — published commitments. The card grid shows {ctx.tenant.name}&rsquo;s last
          12 months against each target. Latency targets can be auto-computed from{" "}
          <code className="rounded bg-ink/5 px-1">ModelRun</code> latency logs; availability is
          recorded from external uptime monitoring.
        </p>
      </div>

      {view.latestMissed > 0 && (
        <section className="card border-red-300 bg-red-50/50 text-sm">
          <strong>{view.latestMissed} target{view.latestMissed === 1 ? "" : "s"} missed</strong>{" "}
          in the latest measured period.
        </section>
      )}

      <section className="card grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {view.targets.map((t) => (
          <SlaCard key={t.id} target={t} />
        ))}
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Adherence KPIs ({latestPeriod})</h2>
        <p className="text-xs text-ink/60">
          PRD §13.3 firm-wide rollup over communications sent this calendar month.
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Response-time adherence"
            value={kpis.responseTimeAdherencePct == null ? "—" : `${kpis.responseTimeAdherencePct}%`}
            sub="% within FCG window"
          />
          <Kpi
            label="Tone adherence avg"
            value={
              kpis.toneAdherenceAvg == null
                ? "—"
                : (Math.round(kpis.toneAdherenceAvg * 100) / 100).toFixed(2)
            }
            sub="0..1 against FCG/UCG"
          />
          <Kpi
            label="Draft acceptance"
            value={kpis.draftAcceptanceRatePct == null ? "—" : `${kpis.draftAcceptanceRatePct}%`}
            sub="<10% character change"
          />
          <Kpi
            label="Sales Identifier conversion"
            value={kpis.salesIdConversionPct == null ? "—" : `${kpis.salesIdConversionPct}%`}
            sub="ACCEPTED + ROUTED / total"
          />
        </div>
        <p className="text-xs text-ink/50">
          Sample size: {kpis.sampleN} communication{kpis.sampleN === 1 ? "" : "s"} with adherence
          scores in this period.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Scalability targets (PRD §13.2)</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>10,000 users per tenant, 1,000 tenants per region without architectural change.</li>
          <li>10M documents per tenant indexed for RAG.</li>
        </ul>
      </section>

      {canManage && (
        <section className="card space-y-3 border-amber-300 bg-amber-50/40">
          <h2 className="text-base font-medium">Record measurement</h2>
          <form action={autoComputeAction} className="grid gap-2 text-sm">
            <p className="text-xs text-ink/60">
              Auto-compute the latency-flavoured targets from{" "}
              <code className="rounded bg-ink/5 px-1">ModelRun</code> for the chosen period. Runs
              the median over <code>draft.short</code>, <code>draft.technical</code>,{" "}
              <code>judge.ucg</code>, <code>voice.transcribe</code> purposes.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                className="input"
                name="period"
                defaultValue={latestPeriod}
                pattern="\d{4}-\d{2}"
                required
              />
              <input
                className="input flex-1"
                name="recordedByName"
                placeholder="Recorded by (name)"
                defaultValue={ctx.user.name ?? ""}
                required
              />
              <button className="btn" type="submit">
                Auto-compute
              </button>
            </div>
          </form>

          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Record manually (availability + overrides)
            </summary>
            <form action={recordAction} className="mt-3 grid gap-2 text-sm">
              <select className="input" name="targetCode" required defaultValue="">
                <option value="" disabled>
                  — choose target —
                </option>
                {view.targets.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name} ({t.threshold} {t.unit})
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-3 gap-2">
                <input
                  className="input"
                  name="period"
                  defaultValue={latestPeriod}
                  pattern="\d{4}-\d{2}"
                  required
                />
                <input
                  className="input"
                  name="observed"
                  type="number"
                  step="0.01"
                  placeholder="Observed value"
                />
                <input
                  className="input"
                  name="sampleN"
                  type="number"
                  defaultValue={0}
                  placeholder="Sample N"
                />
              </div>
              <input
                className="input"
                name="recordedByName"
                placeholder="Recorded by (name)"
                defaultValue={ctx.user.name ?? ""}
                required
              />
              <input className="input" name="note" placeholder="Note (optional)" />
              <button className="btn justify-self-start" type="submit">
                Record
              </button>
            </form>
          </details>
        </section>
      )}

      {isOperator && (
        <section className="card space-y-3 border-amber-300 bg-amber-50/40">
          <h2 className="text-base font-medium">Operator: target catalogue</h2>
          <p className="text-xs text-ink/60">
            Tightening a threshold here changes the published commitment for every Client. Audit
            event lands on the operator&rsquo;s tenant chain.
          </p>
          {view.targets.map((t) => (
            <details key={t.code} className="rounded border border-ink/10 p-3">
              <summary className="cursor-pointer text-sm">
                Edit{" "}
                <code className="rounded bg-ink/5 px-1 text-xs">{t.code}</code> — {t.name}
              </summary>
              <form action={targetAction} className="mt-2 grid gap-2 text-sm">
                <input type="hidden" name="code" value={t.code} />
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs text-ink/60">Threshold ({t.unit})</span>
                    <input
                      className="input"
                      name="threshold"
                      type="number"
                      step="0.01"
                      defaultValue={t.threshold}
                      required
                    />
                  </label>
                  <div className="text-xs text-ink/50 self-end">
                    {SLA_KIND_LABELS[t.kind]} · {t.aggregation} · {t.scope}
                  </div>
                </div>
                <textarea className="input" name="notes" rows={2} defaultValue={t.notes ?? ""} />
                <button className="btn justify-self-start" type="submit">
                  Save
                </button>
              </form>
            </details>
          ))}
        </section>
      )}

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Other §13 surfaces</h2>
        <ul className="grid gap-1 pl-5 text-sm md:grid-cols-2">
          <li className="list-disc">
            <Link
              href={`/${tenantSlug}/accessibility`}
              className="underline decoration-dotted"
            >
              Accessibility statement (§13.4)
            </Link>
          </li>
          <li className="list-disc">
            <Link
              href={`/${tenantSlug}/languages`}
              className="underline decoration-dotted"
            >
              Supported languages (§13.5)
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded bg-ink/5 p-3">
      <div className="text-xs text-ink/60">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="text-[11px] text-ink/50">{sub}</div>
    </div>
  );
}

type ViewTarget = Awaited<ReturnType<typeof getSlaView>>["targets"][number];

function SlaCard({ target }: { target: ViewTarget }) {
  const latest = target.measurements[0];
  const headline = latest?.observed != null ? `${latest.observed.toFixed(2)} ${target.unit}` : "—";
  const tone =
    latest?.outcome === "MET"
      ? "border-emerald-300 bg-emerald-50/60"
      : latest?.outcome === "MISSED"
        ? "border-red-300 bg-red-50/40"
        : "border-ink/10";
  return (
    <div className={`rounded border p-3 text-sm ${tone}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{target.name}</span>
        <span className="text-xs text-ink/60">
          {SLA_KIND_LABELS[target.kind]}
        </span>
      </div>
      <div className="mt-1 text-xs text-ink/60">
        Target: {target.threshold} {target.unit} · {target.aggregation} · {target.scope}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{headline}</span>
        {latest && (
          <span className="text-xs text-ink/60">
            ({latest.period} · {OUTCOME_LABELS[latest.outcome]})
          </span>
        )}
      </div>
      {target.measurements.length > 1 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink/60">
            History ({target.measurements.length} months)
          </summary>
          <ul className="mt-1 space-y-1">
            {target.measurements.map((m) => (
              <li key={m.id} className="flex justify-between">
                <span>{m.period}</span>
                <span>
                  {m.observed != null ? `${m.observed.toFixed(2)} ${target.unit}` : "—"} ·{" "}
                  {OUTCOME_LABELS[m.outcome]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
