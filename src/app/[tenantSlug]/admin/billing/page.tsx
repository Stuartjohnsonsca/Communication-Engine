import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import {
  closeBillingPeriod,
  effectiveSalesIdMinor,
  formatMoney,
  getCurrentEstimate,
  periodForDate,
  planFromTenant,
  previousPeriod,
  updateTenantPlan,
} from "@/lib/billing";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "billing:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const canManage = hasPermission(ctx.membership.role, "billing:manage");

  const [estimate, periods] = await Promise.all([
    getCurrentEstimate(ctx.tenant.id),
    superDb.billingPeriod.findMany({
      where: { tenantId: ctx.tenant.id },
      orderBy: { period: "desc" },
      take: 24,
    }),
  ]);

  const plan = planFromTenant(ctx.tenant);
  const siUnit = effectiveSalesIdMinor(plan);
  const prevPeriodKey = previousPeriod(periodForDate(new Date()));
  const prevClosed = periods.find((p) => p.period === prevPeriodKey && p.status === "CLOSED");

  async function savePlanAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "billing:manage")) throw new Error("forbidden");
    await updateTenantPlan({
      tenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      updates: {
        pricingCurrency: String(formData.get("pricingCurrency") ?? "GBP"),
        pricingBaseMinor: poundsToMinor(formData.get("pricingBase")),
        pricingSalesIdMinor: poundsToMinor(formData.get("pricingSalesId")),
        pricingSalesIdPartnerDefault: formData.get("pricingSalesIdPartnerDefault") === "on",
        pricingSalesIdPartnerDiscountPct: numberOrZero(formData.get("pricingSalesIdPartnerDiscountPct")),
        pricingCrossClientLearningOptIn: formData.get("pricingCrossClientLearningOptIn") === "on",
        pricingCclDiscountPct: numberOrZero(formData.get("pricingCclDiscountPct")),
        pricingCmkEnabled: formData.get("pricingCmkEnabled") === "on",
        pricingCmkMinor: poundsToMinor(formData.get("pricingCmk")),
      },
    });
    revalidatePath(`/${tenantSlug}/admin/billing`);
  }

  async function closeCurrentAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "billing:manage")) throw new Error("forbidden");
    await closeBillingPeriod({
      tenantId: inner.tenant.id,
      period: periodForDate(new Date()),
      actorMembershipId: inner.membership.id,
      allowFutureClose: true,
    });
    revalidatePath(`/${tenantSlug}/admin/billing`);
  }

  async function closePreviousAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "billing:manage")) throw new Error("forbidden");
    await closeBillingPeriod({
      tenantId: inner.tenant.id,
      period: previousPeriod(periodForDate(new Date())),
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/billing`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §15 — per-User-per-month base licence, Sales Identifier add-on, and the
          Customer-Managed-Keys uplift. A User is &ldquo;active&rdquo; for a billing month if
          they have authorised a channel <em>and</em> either logged in or had a draft
          produced in the month.
        </p>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-ink/50">Current month</div>
            <div className="text-xl font-medium">{estimate.period}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-ink/50">Estimated total</div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatMoney(estimate.totals.totalMinor, estimate.totals.currency).display}
            </div>
            {estimate.totals.sandboxFreePeriod && (
              <div className="text-xs text-emerald-700">{estimate.totals.sandboxFreeNote}</div>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Active" value={estimate.totals.activeUsers} />
          <Stat label="Billable" value={estimate.totals.billableUsers} />
          <Stat label="SI add-on" value={estimate.totals.salesIdUsers} />
          <Stat
            label="Effective SI rate"
            value={formatMoney(siUnit, plan.currency).display}
          />
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Line</th>
              <th className="py-1 pr-3 text-right">Qty</th>
              <th className="py-1 pr-3 text-right">Unit</th>
              <th className="py-1 pr-3 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {estimate.totals.lines.map((l, i) => (
              <tr key={i} className="border-t border-ink/5 align-top">
                <td className="py-2 pr-3">
                  <div>{l.label}</div>
                  {l.note && <div className="text-xs text-ink/60">{l.note}</div>}
                </td>
                <td className="py-2 pr-3 text-right">{l.qty}</td>
                <td className="py-2 pr-3 text-right">
                  {formatMoney(l.unitMinor, plan.currency).display}
                </td>
                <td className="py-2 pr-3 text-right">
                  {formatMoney(l.subtotalMinor, plan.currency).display}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Link
            href={`/${tenantSlug}/admin/billing/${estimate.period}`}
            className="btn"
          >
            Per-User breakdown
          </Link>
          <a
            href={`/api/billing/periods/${estimate.period}/export.csv?tenant=${tenantSlug}`}
            className="btn"
          >
            Download CSV
          </a>
          {canManage && (
            <>
              {!prevClosed && (
                <form action={closePreviousAction}>
                  <button type="submit" className="btn">
                    Close {prevPeriodKey}
                  </button>
                </form>
              )}
              <form action={closeCurrentAction}>
                <button type="submit" className="btn">
                  Force-close {estimate.period} now
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {canManage && (
        <form action={savePlanAction} className="card space-y-4">
          <div>
            <h2 className="text-base font-medium">Pricing plan</h2>
            <p className="text-xs text-ink/60">
              Stored in minor units (pence) but entered here as decimal pounds. Every change is
              audited as <code className="font-mono">BILLING_PLAN_UPDATED</code>.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Currency">
              <select name="pricingCurrency" defaultValue={plan.currency} className="input">
                <option value="GBP">GBP</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </Field>
            <Field label="Base licence (per active User / month)">
              <input
                name="pricingBase"
                type="number"
                step="0.01"
                min="0"
                defaultValue={(plan.baseMinor / 100).toFixed(2)}
                className="input"
              />
            </Field>
            <Field label="Sales Identifier add-on (per User / month)">
              <input
                name="pricingSalesId"
                type="number"
                step="0.01"
                min="0"
                defaultValue={(plan.salesIdMinor / 100).toFixed(2)}
                className="input"
              />
            </Field>
            <Field label="Acumon-default Partner discount (%)">
              <input
                name="pricingSalesIdPartnerDiscountPct"
                type="number"
                step="1"
                min="0"
                max="100"
                defaultValue={plan.salesIdPartnerDiscountPct}
                className="input"
              />
            </Field>
            <Field label="Cross-Client Learning discount (%)">
              <input
                name="pricingCclDiscountPct"
                type="number"
                step="1"
                min="0"
                max="100"
                defaultValue={plan.cclDiscountPct}
                className="input"
              />
            </Field>
            <Field label="Customer-Managed Keys uplift (per tenant / month)">
              <input
                name="pricingCmk"
                type="number"
                step="0.01"
                min="0"
                defaultValue={(plan.cmkMinor / 100).toFixed(2)}
                className="input"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="pricingSalesIdPartnerDefault"
                defaultChecked={plan.salesIdPartnerDefault}
              />
              <span>Acumon Intelligence is the default Partner</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="pricingCrossClientLearningOptIn"
                defaultChecked={plan.crossClientLearningOptIn}
              />
              <span>Cross-Client Learning opt-in</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="pricingCmkEnabled"
                defaultChecked={plan.cmkEnabled}
              />
              <span>Customer-Managed Keys enabled</span>
            </label>
          </div>
          <button type="submit" className="btn btn-primary">
            Save plan
          </button>
        </form>
      )}

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Closed periods</h2>
          <span className="text-xs text-ink/60">most recent first</span>
        </div>
        {periods.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">
            No periods on file yet. The cron at <code className="font-mono">/api/cron/billing-close</code>{" "}
            closes the previous month on the 1st of each month; you can also force-close above.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">Period</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3 text-right">Billable</th>
                <th className="py-1 pr-3 text-right">SI</th>
                <th className="py-1 pr-3 text-right">Total</th>
                <th className="py-1 pr-3">Closed</th>
                <th className="py-1 pr-3" />
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className="border-t border-ink/5">
                  <td className="py-2 pr-3 font-mono">{p.period}</td>
                  <td className="py-2 pr-3">
                    <span className={`tag ${p.status === "CLOSED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right">{p.billableUsers}</td>
                  <td className="py-2 pr-3 text-right">{p.salesIdUsers}</td>
                  <td className="py-2 pr-3 text-right">
                    {formatMoney(p.totalMinor, p.currency).display}
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink/60">
                    {p.closedAt ? p.closedAt.toISOString().slice(0, 10) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Link
                      href={`/${tenantSlug}/admin/billing/${p.period}`}
                      className="text-xs underline decoration-dotted"
                    >
                      open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card text-xs text-ink/60">
        <h3 className="text-sm font-medium text-ink">PRD §15.3 — switching and lock-in</h3>
        <p className="mt-1">
          Customer data is exportable on demand at no charge during the contract. The DSAR module
          (<Link href={`/${tenantSlug}/dsar`} className="underline">/dsar</Link>) emits the
          per-User and per-counterparty packages; tenant-wide export and the 90-day post-termination
          purge are tracked separately under PRD §14.4.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink/50">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <div className="mb-1 text-xs text-ink/60">{label}</div>
      {children}
    </label>
  );
}

function poundsToMinor(v: FormDataEntryValue | null): number | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function numberOrZero(v: FormDataEntryValue | null): number | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return n;
}
