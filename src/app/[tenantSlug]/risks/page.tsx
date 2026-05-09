import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { getRisks, reviewRisk, updateRisk, SEVERITY_ORDER } from "@/lib/risks";
import type { RiskSeverity, RiskStatus } from "@prisma/client";

const SEVERITY_BADGE: Record<RiskSeverity, string> = {
  HIGH: "bg-red-100 text-red-800",
  MEDIUM: "bg-amber-100 text-amber-900",
  LOW: "bg-emerald-100 text-emerald-800",
};

const STATUS_BADGE: Record<RiskStatus, string> = {
  ACTIVE: "bg-sky-100 text-sky-800",
  MITIGATED: "bg-emerald-100 text-emerald-800",
  ACCEPTED: "bg-ink/10 text-ink/70",
  CLOSED: "bg-ink/5 text-ink/50",
};

const STATUS_OPTIONS: RiskStatus[] = ["ACTIVE", "MITIGATED", "ACCEPTED", "CLOSED"];
const SEVERITY_OPTIONS: RiskSeverity[] = ["HIGH", "MEDIUM", "LOW"];

/**
 * Acumon-internal tenant — only operators here can mutate the global risks
 * register. Same gate the Roadmap (§16) uses.
 */
const ACUMON_TENANT_SLUG = "acumon";

export default async function RisksPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "risks:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getRisks();

  const isOperator =
    ctx.tenant.slug === ACUMON_TENANT_SLUG &&
    hasPermission(ctx.membership.role, "risks:manage");

  async function updateRiskAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "risks:manage")
    ) {
      throw new Error("forbidden");
    }
    const code = String(formData.get("code") ?? "");
    const status = String(formData.get("status") ?? "") as RiskStatus;
    const severity = String(formData.get("severity") ?? "") as RiskSeverity;
    const notes = (formData.get("notes") as string | null) ?? null;
    if (!STATUS_OPTIONS.includes(status)) throw new Error("invalid status");
    if (!SEVERITY_OPTIONS.includes(severity)) throw new Error("invalid severity");
    await updateRisk({
      code,
      status,
      severity,
      notes,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/risks`);
  }

  async function reviewRiskAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "risks:manage")
    ) {
      throw new Error("forbidden");
    }
    const code = String(formData.get("code") ?? "");
    const reviewedByName = (formData.get("reviewedByName") as string | null) ?? null;
    await reviewRisk({
      code,
      reviewedByName,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      actorName: inner.user.name ?? inner.user.email,
    });
    revalidatePath(`/${tenantSlug}/risks`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Risks register</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §17 — product-level risks Acumon faces in delivering the service, with the
          mitigations baked into the platform. Published per PRD §15.3 so every Client can see
          how the controls map back to their concerns.
        </p>
      </div>

      {!isOperator && (
        <div className="card text-xs text-ink/60">
          Read-only view. Severity, status, and review ticks are maintained by Acumon
          Intelligence operators; the data here reflects their last update.
        </div>
      )}

      <Summary view={view} />

      <div className="space-y-4">
        {view.risks.map((r) => (
          <RiskCard
            key={r.id}
            risk={r}
            isOperator={isOperator}
            updateRiskAction={updateRiskAction}
            reviewRiskAction={reviewRiskAction}
          />
        ))}
      </div>
    </div>
  );
}

function Summary({ view }: { view: Awaited<ReturnType<typeof getRisks>> }) {
  const sevLine = SEVERITY_ORDER.map((s) => `${view.summary.bySeverity[s]} ${s.toLowerCase()}`).join(" · ");
  const active = view.summary.byStatus.ACTIVE;
  const mitigated = view.summary.byStatus.MITIGATED;
  return (
    <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Total" value={String(view.summary.total)} />
      <Stat label="By severity" value={sevLine} />
      <Stat label="Active / mitigated" value={`${active} / ${mitigated}`} />
      <Stat label="Never reviewed" value={String(view.summary.neverReviewed)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink/50">{label}</div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}

function RiskCard({
  risk,
  isOperator,
  updateRiskAction,
  reviewRiskAction,
}: {
  risk: Awaited<ReturnType<typeof getRisks>>["risks"][number];
  isOperator: boolean;
  updateRiskAction: (formData: FormData) => Promise<void>;
  reviewRiskAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">{risk.code}</div>
          <h2 className="text-lg font-medium">{risk.title}</h2>
          <div className="text-xs text-ink/60">
            {risk.reviewedAt ? (
              <>
                Last reviewed {risk.reviewedAt.toISOString().slice(0, 10)}
                {risk.reviewedByName && <> · {risk.reviewedByName}</>}
              </>
            ) : (
              <span className="text-amber-700">Never reviewed</span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <span className={`tag ${SEVERITY_BADGE[risk.severity]}`}>{risk.severity}</span>
          <span className={`tag ${STATUS_BADGE[risk.status]}`}>{risk.status}</span>
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-ink/50">Mitigations</div>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {risk.mitigations.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>

      {risk.notes && !isOperator && (
        <div className="rounded border border-ink/10 bg-ink/5 p-2 text-sm">
          <div className="text-xs uppercase tracking-wider text-ink/50">Notes</div>
          <div className="mt-0.5 whitespace-pre-wrap">{risk.notes}</div>
        </div>
      )}

      {isOperator && (
        <div className="space-y-3 rounded border border-ink/10 bg-ink/5 p-3">
          <form action={updateRiskAction} className="space-y-3">
            <input type="hidden" name="code" value={risk.code} />
            <div className="grid gap-3 sm:grid-cols-[160px_160px_1fr]">
              <label className="block text-sm">
                <div className="mb-1 text-xs text-ink/60">Severity</div>
                <select name="severity" defaultValue={risk.severity} className="input">
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <div className="mb-1 text-xs text-ink/60">Status</div>
                <select name="status" defaultValue={risk.status} className="input">
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <div className="mb-1 text-xs text-ink/60">Notes (control owner, incident links…)</div>
                <textarea
                  name="notes"
                  rows={2}
                  className="input"
                  defaultValue={risk.notes ?? ""}
                />
              </label>
            </div>
            <button type="submit" className="btn btn-primary text-xs">
              Save {risk.code}
            </button>
          </form>

          <form action={reviewRiskAction} className="flex flex-wrap items-end gap-3 border-t border-ink/10 pt-3">
            <input type="hidden" name="code" value={risk.code} />
            <label className="block text-sm">
              <div className="mb-1 text-xs text-ink/60">Reviewed by (optional — defaults to you)</div>
              <input
                name="reviewedByName"
                className="input"
                placeholder="e.g. DPO, Head of Risk"
              />
            </label>
            <button type="submit" className="btn text-xs">
              Mark reviewed today
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
