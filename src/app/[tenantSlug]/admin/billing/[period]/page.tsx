import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import {
  closeBillingPeriod,
  formatMoney,
  getEstimate,
  parsePeriod,
  reopenBillingPeriod,
} from "@/lib/billing";

type RowSnapshotShape = {
  userEmail: string;
  role: string;
  membershipStatus: string;
  hasAuthorisedChannel: boolean;
  loggedInThisPeriod: boolean;
  hadDraftThisPeriod: boolean;
  draftCount: number;
  isActiveByPRD: boolean;
  isBillable: boolean;
  salesIdentifierApplies: boolean;
  reason: string;
};

export default async function BillingPeriodPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; period: string }>;
}) {
  const { tenantSlug, period } = await params;
  try {
    parsePeriod(period);
  } catch {
    redirect(`/${tenantSlug}/admin/billing`);
  }
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "billing:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }
  const canManage = hasPermission(ctx.membership.role, "billing:manage");

  const closed = await superDb.billingPeriod.findUnique({
    where: { tenantId_period: { tenantId: ctx.tenant.id, period } },
    include: {
      snapshots: { orderBy: [{ isBillable: "desc" }, { userEmail: "asc" }] },
      tenant: { select: { pricingCurrency: true } },
    },
  });

  let rows: RowSnapshotShape[];
  let totalMinor: number;
  let baseSubtotalMinor: number;
  let salesIdSubtotalMinor: number;
  let cmkSubtotalMinor: number;
  let billableUsers: number;
  let activeUsers: number;
  let salesIdUsers: number;
  let currency: string;
  let status: "DRAFT" | "CLOSED" | "ESTIMATE";
  let closedAt: Date | null = null;
  let lines: { label: string; qty: number; unitMinor: number; subtotalMinor: number; note?: string }[] = [];
  let sandboxFreeNote: string | null = null;

  if (closed && closed.status === "CLOSED") {
    rows = closed.snapshots.map((s) => ({
      userEmail: s.userEmail,
      role: s.role,
      membershipStatus: s.membershipStatus,
      hasAuthorisedChannel: s.hasAuthorisedChannel,
      loggedInThisPeriod: s.loggedInThisPeriod,
      hadDraftThisPeriod: s.hadDraftThisPeriod,
      draftCount: s.draftCount,
      isActiveByPRD: s.isActiveByPRD,
      isBillable: s.isBillable,
      salesIdentifierApplies: s.salesIdentifierApplies,
      reason: s.reason,
    }));
    totalMinor = closed.totalMinor;
    baseSubtotalMinor = closed.baseSubtotalMinor;
    salesIdSubtotalMinor = closed.salesIdSubtotalMinor;
    cmkSubtotalMinor = closed.cmkSubtotalMinor;
    billableUsers = closed.billableUsers;
    activeUsers = closed.activeUsers;
    salesIdUsers = closed.salesIdUsers;
    currency = closed.currency;
    status = "CLOSED";
    closedAt = closed.closedAt;
    const payload = closed.payload as {
      totals?: {
        lines?: { label: string; qty: number; unitMinor: number; subtotalMinor: number; note?: string }[];
        sandboxFreeNote?: string | null;
      };
    } | null;
    lines = payload?.totals?.lines ?? [];
    sandboxFreeNote = payload?.totals?.sandboxFreeNote ?? null;
  } else {
    const est = await getEstimate({ tenantId: ctx.tenant.id, period });
    rows = est.rows.map((r) => ({
      userEmail: r.membership.user.email,
      role: r.membership.role,
      membershipStatus: r.membership.status,
      hasAuthorisedChannel: r.hasAuthorisedChannel,
      loggedInThisPeriod: r.loggedInThisPeriod,
      hadDraftThisPeriod: r.hadDraftThisPeriod,
      draftCount: r.draftCount,
      isActiveByPRD: r.isActiveByPRD,
      isBillable: r.isBillable,
      salesIdentifierApplies: r.salesIdentifierApplies,
      reason: r.reason,
    }));
    totalMinor = est.totals.totalMinor;
    baseSubtotalMinor = est.totals.baseSubtotalMinor;
    salesIdSubtotalMinor = est.totals.salesIdSubtotalMinor;
    cmkSubtotalMinor = est.totals.cmkSubtotalMinor;
    billableUsers = est.totals.billableUsers;
    activeUsers = est.totals.activeUsers;
    salesIdUsers = est.totals.salesIdUsers;
    currency = est.totals.currency;
    status = est.isCurrentMonth ? "ESTIMATE" : "DRAFT";
    lines = est.totals.lines;
    sandboxFreeNote = est.totals.sandboxFreeNote;
  }

  async function closeAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "billing:manage")) throw new Error("forbidden");
    await closeBillingPeriod({
      tenantId: inner.tenant.id,
      period,
      actorMembershipId: inner.membership.id,
      allowFutureClose: status === "ESTIMATE",
    });
    revalidatePath(`/${tenantSlug}/admin/billing/${period}`);
    revalidatePath(`/${tenantSlug}/admin/billing`);
  }

  async function reopenAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "billing:manage")) throw new Error("forbidden");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) throw new Error("reason required");
    await reopenBillingPeriod({
      tenantId: inner.tenant.id,
      period,
      actorMembershipId: inner.membership.id,
      reason,
    });
    revalidatePath(`/${tenantSlug}/admin/billing/${period}`);
    revalidatePath(`/${tenantSlug}/admin/billing`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <Link href={`/${tenantSlug}/admin/billing`} className="text-xs underline decoration-dotted">
            ← All periods
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Period {period}</h1>
          <p className="text-sm text-ink/70">
            {status === "CLOSED"
              ? `Closed ${closedAt?.toISOString().slice(0, 10) ?? "—"}.`
              : status === "ESTIMATE"
                ? "In-progress month — totals will move until close."
                : "Draft — period has ended but has not yet been closed."}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-ink/50">Total</div>
          <div className="text-3xl font-semibold tracking-tight">
            {formatMoney(totalMinor, currency).display}
          </div>
        </div>
      </div>

      {sandboxFreeNote && (
        <div className="rounded border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900">
          {sandboxFreeNote}
        </div>
      )}

      <div className="card grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Stat label="Active" value={activeUsers} />
        <Stat label="Billable" value={billableUsers} />
        <Stat label="SI add-on" value={salesIdUsers} />
        <Stat label="Base subtotal" value={formatMoney(baseSubtotalMinor, currency).display} />
        <Stat label="SI subtotal" value={formatMoney(salesIdSubtotalMinor, currency).display} />
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Invoice lines</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Line</th>
              <th className="py-1 pr-3 text-right">Qty</th>
              <th className="py-1 pr-3 text-right">Unit</th>
              <th className="py-1 pr-3 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-ink/5 align-top">
                <td className="py-2 pr-3">
                  <div>{l.label}</div>
                  {l.note && <div className="text-xs text-ink/60">{l.note}</div>}
                </td>
                <td className="py-2 pr-3 text-right">{l.qty}</td>
                <td className="py-2 pr-3 text-right">{formatMoney(l.unitMinor, currency).display}</td>
                <td className="py-2 pr-3 text-right">{formatMoney(l.subtotalMinor, currency).display}</td>
              </tr>
            ))}
            {cmkSubtotalMinor === 0 && lines.every((l) => !l.label.startsWith("Customer-Managed")) && (
              <tr className="border-t border-ink/5 text-xs text-ink/50">
                <td colSpan={4} className="py-2">CMK uplift not enabled.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Per-User breakdown</h2>
          <a
            href={`/api/billing/periods/${period}/export.csv?tenant=${tenantSlug}`}
            className="btn text-xs"
          >
            Download CSV
          </a>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">User</th>
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Channel</th>
              <th className="py-1 pr-3">Logged in</th>
              <th className="py-1 pr-3">Drafts</th>
              <th className="py-1 pr-3">Billable</th>
              <th className="py-1 pr-3">SI</th>
              <th className="py-1 pr-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-3 text-center text-ink/50">
                  No memberships in this tenant yet.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-t border-ink/5">
                  <td className="py-2 pr-3">
                    <div>{r.userEmail}</div>
                    <div className="text-xs text-ink/50">{r.membershipStatus}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="tag">{r.role}</span>
                  </td>
                  <td className="py-2 pr-3">{r.hasAuthorisedChannel ? "yes" : "—"}</td>
                  <td className="py-2 pr-3">{r.loggedInThisPeriod ? "yes" : "—"}</td>
                  <td className="py-2 pr-3">{r.draftCount}</td>
                  <td className="py-2 pr-3">
                    {r.isBillable ? (
                      <span className="tag bg-emerald-100 text-emerald-800">billable</span>
                    ) : (
                      <span className="tag bg-ink/10 text-ink/60">no</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{r.salesIdentifierApplies ? "yes" : "—"}</td>
                  <td className="py-2 pr-3 text-xs text-ink/60">{r.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="card flex flex-wrap items-center gap-3">
          {status !== "CLOSED" ? (
            <form action={closeAction}>
              <button type="submit" className="btn btn-primary text-sm">
                {status === "ESTIMATE" ? "Force-close this period now" : "Close period"}
              </button>
            </form>
          ) : (
            <form action={reopenAction} className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                name="reason"
                required
                placeholder="Reason for reopen"
                maxLength={200}
                className="input text-sm"
              />
              <button type="submit" className="btn text-sm">
                Reopen period
              </button>
            </form>
          )}
        </div>
      )}
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
