import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { getRoadmap, setExitCriterion, summarisePhase, updatePhase, type RoadmapPhaseWithCriteria } from "@/lib/roadmap";
import type { RoadmapPhaseStatus } from "@prisma/client";

const STATUS_BADGE: Record<RoadmapPhaseStatus, string> = {
  PLANNED: "bg-ink/10 text-ink/70",
  ACTIVE: "bg-sky-100 text-sky-800",
  COMPLETE: "bg-emerald-100 text-emerald-800",
};

const STATUS_OPTIONS: RoadmapPhaseStatus[] = ["PLANNED", "ACTIVE", "COMPLETE"];

/**
 * Acumon-internal tenants are those whose slug is "acumon". Only operators
 * sitting inside the Acumon tenant can mutate the global roadmap; every
 * other Client sees a read-only view.
 */
const ACUMON_TENANT_SLUG = "acumon";

export default async function RoadmapPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "roadmap:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getRoadmap();

  const isOperator =
    ctx.tenant.slug === ACUMON_TENANT_SLUG &&
    hasPermission(ctx.membership.role, "roadmap:manage");

  async function updatePhaseAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "roadmap:manage")
    ) {
      throw new Error("forbidden");
    }
    const code = String(formData.get("code") ?? "");
    const status = String(formData.get("status") ?? "") as RoadmapPhaseStatus;
    const notes = (formData.get("notes") as string | null) ?? null;
    if (!STATUS_OPTIONS.includes(status)) throw new Error("invalid status");
    await updatePhase({
      code,
      status,
      notes,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/roadmap`);
  }

  async function toggleCriterionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "roadmap:manage")
    ) {
      throw new Error("forbidden");
    }
    const criterionId = String(formData.get("criterionId") ?? "");
    const met = formData.get("met") === "true";
    const metByName = (formData.get("metByName") as string | null) ?? null;
    await setExitCriterion({
      criterionId,
      met,
      metByName,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      actorName: inner.user.name ?? inner.user.email,
    });
    revalidatePath(`/${tenantSlug}/roadmap`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Roadmap</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §16 — five phases from internal pilot through enterprise &amp; AI Act conformity.
          Months are counted from product start. Published per PRD §15.3 so every Client can see
          when an asked-for capability is expected.
        </p>
      </div>

      {!isOperator && (
        <div className="card text-xs text-ink/60">
          Read-only view. Status and exit-criterion edits are made by Acumon Intelligence
          operators; the data here reflects their last update.
        </div>
      )}

      <Summary phases={view.phases} />

      <div className="space-y-4">
        {view.phases.map((p) => (
          <PhaseCard
            key={p.id}
            phase={p}
            isOperator={isOperator}
            updatePhaseAction={updatePhaseAction}
            toggleCriterionAction={toggleCriterionAction}
          />
        ))}
      </div>
    </div>
  );
}

function Summary({ phases }: { phases: RoadmapPhaseWithCriteria[] }) {
  const summaries = phases.map(summarisePhase);
  const active = summaries.find((s) => s.status === "ACTIVE");
  const completed = summaries.filter((s) => s.status === "COMPLETE").length;
  const totalCriteria = summaries.reduce((acc, s) => acc + s.exitCriteriaTotal, 0);
  const metCriteria = summaries.reduce((acc, s) => acc + s.exitCriteriaMet, 0);
  return (
    <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat
        label="Phases complete"
        value={`${completed} / ${summaries.length}`}
      />
      <Stat
        label="Active phase"
        value={active ? `${active.code} · ${active.name}` : "—"}
      />
      <Stat
        label="Exit criteria met"
        value={`${metCriteria} / ${totalCriteria}`}
      />
      <Stat
        label="Window covered"
        value={`Months 0–${Math.max(...summaries.map((s) => s.windowMonthsEnd), 0)}`}
      />
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

function PhaseCard({
  phase,
  isOperator,
  updatePhaseAction,
  toggleCriterionAction,
}: {
  phase: RoadmapPhaseWithCriteria;
  isOperator: boolean;
  updatePhaseAction: (formData: FormData) => Promise<void>;
  toggleCriterionAction: (formData: FormData) => Promise<void>;
}) {
  const totalCriteria = phase.exitCriteria.length;
  const metCriteria = phase.exitCriteria.filter((c) => c.metAt != null).length;
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">{phase.code}</div>
          <h2 className="text-lg font-medium">{phase.name}</h2>
          <div className="text-xs text-ink/60">
            Months {phase.windowMonthsStart}–{phase.windowMonthsEnd}
            {phase.startedAt && (
              <> · started {phase.startedAt.toISOString().slice(0, 10)}</>
            )}
            {phase.completedAt && (
              <> · completed {phase.completedAt.toISOString().slice(0, 10)}</>
            )}
          </div>
        </div>
        <span className={`tag ${STATUS_BADGE[phase.status]}`}>{phase.status}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">Scope</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {phase.scope.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <div className="text-xs uppercase tracking-wider text-ink/50">Exit criteria</div>
            <div className="text-xs text-ink/50">{metCriteria} / {totalCriteria} met</div>
          </div>
          <ul className="mt-1 space-y-2 text-sm">
            {phase.exitCriteria.map((c) => (
              <li key={c.id} className="rounded border border-ink/10 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] font-bold ${
                        c.metAt
                          ? "border-emerald-400 bg-emerald-100 text-emerald-700"
                          : "border-ink/20 text-ink/30"
                      }`}
                      aria-hidden
                    >
                      {c.metAt ? "✓" : ""}
                    </span>
                    <div>
                      <div>{c.text}</div>
                      {c.metAt && (
                        <div className="text-xs text-ink/50">
                          met {c.metAt.toISOString().slice(0, 10)}
                          {c.metByName && <> · {c.metByName}</>}
                        </div>
                      )}
                    </div>
                  </div>
                  {isOperator && (
                    <form action={toggleCriterionAction}>
                      <input type="hidden" name="criterionId" value={c.id} />
                      <input type="hidden" name="met" value={c.metAt ? "false" : "true"} />
                      <button type="submit" className="btn text-xs">
                        {c.metAt ? "Mark unmet" : "Mark met"}
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {phase.notes && !isOperator && (
        <div className="rounded border border-ink/10 bg-ink/5 p-2 text-sm">
          <div className="text-xs uppercase tracking-wider text-ink/50">Notes</div>
          <div className="mt-0.5 whitespace-pre-wrap">{phase.notes}</div>
        </div>
      )}

      {isOperator && (
        <form action={updatePhaseAction} className="rounded border border-ink/10 bg-ink/5 p-3 space-y-3">
          <input type="hidden" name="code" value={phase.code} />
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <label className="block text-sm">
              <div className="mb-1 text-xs text-ink/60">Status</div>
              <select name="status" defaultValue={phase.status} className="input">
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <div className="mb-1 text-xs text-ink/60">Notes (operator commentary, links to release notes…)</div>
              <textarea
                name="notes"
                rows={2}
                className="input"
                defaultValue={phase.notes ?? ""}
              />
            </label>
          </div>
          <button type="submit" className="btn btn-primary text-xs">
            Save {phase.code}
          </button>
        </form>
      )}
    </div>
  );
}
