import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  PHASES_IN_ORDER,
  PHASE_LABELS,
  getOnboardingState,
  nextPhase,
  prevPhase,
  setOnboardingPhase,
  tickStep,
} from "@/lib/onboarding";
import type { OnboardingPhase } from "@prisma/client";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "onboarding:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const state = await getOnboardingState(ctx.tenant);
  const canManage = hasPermission(ctx.membership.role, "onboarding:manage");

  async function tickAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "onboarding:manage")) throw new Error("forbidden");
    await tickStep({
      tenantId: inner.tenant.id,
      code: String(formData.get("code") ?? ""),
      checked: formData.get("checked") === "true",
      checkedByName: String(formData.get("checkedByName") ?? ""),
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/onboarding`);
  }

  async function phaseAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "onboarding:manage")) throw new Error("forbidden");
    await setOnboardingPhase({
      tenantId: inner.tenant.id,
      phase: String(formData.get("phase") ?? "COMMERCIAL") as OnboardingPhase,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/onboarding`);
  }

  const isLive = state.tenant.onboardingPhase === "LIVE";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Onboarding</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §14.1 — six-phase Client onboarding from Order Form to Production go-live. The
          checklist auto-detects items the platform can observe (DPIA attestation, FCG commit,
          sandbox provisioning, etc.) and accepts manual ticks for items it cannot.
        </p>
      </div>

      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink/60">Current phase</div>
          <div className="text-2xl font-semibold">
            {PHASE_LABELS[state.tenant.onboardingPhase]}
          </div>
          {state.tenant.onboardingStartedAt && (
            <div className="text-xs text-ink/60">
              Started {state.tenant.onboardingStartedAt.toISOString().slice(0, 10)}
            </div>
          )}
          {state.tenant.onboardingCompletedAt && (
            <div className="text-xs text-emerald-700">
              Completed {state.tenant.onboardingCompletedAt.toISOString().slice(0, 10)}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-ink/60">Progress</div>
          <div className="text-3xl font-semibold">{state.progressPct}%</div>
          <div className="mt-1 h-2 w-32 rounded bg-ink/10">
            <div
              className="h-2 rounded bg-emerald-500"
              style={{ width: `${state.progressPct}%` }}
            />
          </div>
        </div>
      </section>

      {canManage && !isLive && (
        <section className="card flex flex-wrap items-center gap-2 border-amber-300 bg-amber-50/40">
          <span className="text-sm font-medium">Advance phase:</span>
          {prevPhase(state.tenant.onboardingPhase) && (
            <form action={phaseAction} className="inline">
              <input
                type="hidden"
                name="phase"
                value={prevPhase(state.tenant.onboardingPhase) ?? ""}
              />
              <button className="btn text-xs" type="submit">
                ← {PHASE_LABELS[prevPhase(state.tenant.onboardingPhase)!]}
              </button>
            </form>
          )}
          {nextPhase(state.tenant.onboardingPhase) && (
            <form action={phaseAction} className="inline">
              <input
                type="hidden"
                name="phase"
                value={nextPhase(state.tenant.onboardingPhase) ?? ""}
              />
              <button className="btn btn-primary text-xs" type="submit">
                Move to {PHASE_LABELS[nextPhase(state.tenant.onboardingPhase)!]} →
              </button>
            </form>
          )}
        </section>
      )}

      {PHASES_IN_ORDER.filter((p) => p !== "LIVE").map((phase) => {
        const steps = state.byPhase[phase];
        const phaseDone = steps.filter((s) => s.done).length;
        const phaseTotal = steps.length;
        const isCurrent = phase === state.tenant.onboardingPhase;
        return (
          <section
            key={phase}
            className={`card space-y-3 ${
              isCurrent ? "border-sky-300 bg-sky-50/30" : ""
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-medium">{PHASE_LABELS[phase]}</h2>
              <span className="text-xs text-ink/60">
                {phaseDone} / {phaseTotal} done
              </span>
            </div>
            <ul className="space-y-2">
              {steps.map((step) => (
                <li
                  key={step.code}
                  className={`rounded border p-3 text-sm ${
                    step.done ? "border-emerald-300 bg-emerald-50/40" : "border-ink/10"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-medium">{step.title}</span>
                      {step.source === "detected" && step.done && (
                        <span className="ml-2 tag bg-emerald-100 text-xs text-emerald-900">
                          Auto-detected
                        </span>
                      )}
                      {step.source === "manual" && (
                        <span className="ml-2 tag bg-sky-100 text-xs text-sky-900">
                          Manually ticked
                        </span>
                      )}
                    </div>
                    {step.href && (
                      <Link
                        href={`/${tenantSlug}${step.href}`}
                        className="text-xs underline decoration-dotted"
                      >
                        Open →
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink/60">{step.detail}</p>
                  {step.manualCheckedAt && (
                    <div className="mt-1 text-xs text-ink/60">
                      Ticked {step.manualCheckedAt.toISOString().slice(0, 10)}
                      {step.manualCheckedByName ? ` by ${step.manualCheckedByName}` : ""}
                    </div>
                  )}
                  {step.notes && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-ink/70">{step.notes}</p>
                  )}
                  {canManage && step.source !== "detected" && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-ink/60">
                        {step.done ? "Untick / amend" : "Tick this step"}
                      </summary>
                      <form action={tickAction} className="mt-2 grid gap-1 text-sm">
                        <input type="hidden" name="code" value={step.code} />
                        <input
                          type="hidden"
                          name="checked"
                          value={step.done ? "false" : "true"}
                        />
                        {!step.done && (
                          <input
                            className="input"
                            name="checkedByName"
                            required
                            placeholder="Ticked by (your name)"
                            defaultValue={ctx.user.name ?? ""}
                          />
                        )}
                        <input
                          className="input"
                          name="notes"
                          placeholder="Optional note"
                          defaultValue={step.notes ?? ""}
                        />
                        <button className="btn justify-self-start" type="submit">
                          {step.done ? "Untick" : "Mark complete"}
                        </button>
                      </form>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {!isLive && state.progressPct === 100 && canManage && (
        <section className="card border-emerald-300 bg-emerald-50/50">
          <h2 className="text-base font-medium text-emerald-900">
            All checklist items complete
          </h2>
          <p className="mt-1 text-sm">
            Move the tenant to <strong>LIVE</strong> to mark onboarding complete.
          </p>
          <form action={phaseAction} className="mt-2">
            <input type="hidden" name="phase" value="LIVE" />
            <button className="btn btn-primary" type="submit">
              Complete onboarding
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
