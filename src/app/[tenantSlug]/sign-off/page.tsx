import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  decideQuestion,
  getSignOffQuestions,
  reopenQuestion,
  updateQuestion,
  STATUS_OPTIONS,
} from "@/lib/signoff";
import type { SignOffStatus } from "@prisma/client";

/**
 * PRD §18 — Open Questions for Sign-Off. Internal Acumon governance only:
 * unlike Roadmap (§16) and Risks (§17), this surface is NOT published to
 * Client tenants. Both reads and writes require:
 *   1. an authenticated session with an ACTIVE membership in the "acumon" tenant; and
 *   2. the `signoff:read` / `signoff:manage` permission for the user's role.
 *
 * Any other tenant slug returns 404 — we don't even confirm the route exists,
 * so a Client-tenant operator scanning URLs can't fingerprint the feature.
 *
 * The server actions below re-resolve the tenant context inside the action
 * (don't trust the closure-captured `ctx`) and re-check the gate. The lib
 * helpers additionally re-read the actor's membership and verify the
 * tenant slug — defence in depth, in case a future change loosens this
 * page's gate by accident.
 */
const ACUMON_TENANT_SLUG = "acumon";

const STATUS_BADGE: Record<SignOffStatus, string> = {
  OPEN: "bg-amber-100 text-amber-900",
  DECIDED: "bg-emerald-100 text-emerald-800",
  DEFERRED: "bg-ink/10 text-ink/70",
};

export default async function SignOffPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  // Tenant-slug gate first — return 404 (not 403) so non-Acumon operators
  // can't tell whether this route exists.
  if (tenantSlug !== ACUMON_TENANT_SLUG) notFound();

  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  if (!hasPermission(ctx.membership.role, "signoff:read")) {
    notFound();
  }

  const view = await getSignOffQuestions();
  const canManage = hasPermission(ctx.membership.role, "signoff:manage");

  async function decideAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "signoff:manage")
    ) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const decidedByName = (formData.get("decidedByName") as string | null) ?? null;
    const notes = (formData.get("notes") as string | null) ?? null;

    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");
    if (!decision.trim()) throw new Error("decision text is required");

    await decideQuestion({
      code,
      decision,
      decidedByName,
      notes,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      actorName: inner.user.name ?? inner.user.email,
    });
    revalidatePath(`/${tenantSlug}/sign-off`);
  }

  async function reopenAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "signoff:manage")
    ) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");

    await reopenQuestion({
      code,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/sign-off`);
  }

  async function deferAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      inner.tenant.slug !== ACUMON_TENANT_SLUG ||
      !hasPermission(inner.membership.role, "signoff:manage")
    ) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    const notes = (formData.get("notes") as string | null) ?? null;
    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");

    await updateQuestion({
      code,
      status: "DEFERRED",
      notes,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/sign-off`);
  }

  const remaining = view.summary.byStatus.OPEN;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Open Questions for Sign-Off</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §18 — the {view.summary.total} questions that need explicit decisions before
          GA. Unlike the Roadmap and Risks registers, this view is internal: only Acumon
          operators can see it. Decisions logged here are written to the audit chain.
        </p>
      </div>

      <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total" value={String(view.summary.total)} />
        <Stat label="Open" value={String(view.summary.byStatus.OPEN)} />
        <Stat label="Decided" value={String(view.summary.byStatus.DECIDED)} />
        <Stat label="Deferred" value={String(view.summary.byStatus.DEFERRED)} />
      </div>

      {remaining === 0 && view.summary.byStatus.DEFERRED === 0 && (
        <div className="card border-emerald-300 bg-emerald-50/60 text-sm text-emerald-900">
          All sign-off questions have an explicit decision recorded. The audit chain captures who decided what and when.
        </div>
      )}

      <ol className="space-y-4">
        {view.questions.map((q) => (
          <QuestionCard
            key={q.id}
            question={q}
            canManage={canManage}
            decideAction={decideAction}
            reopenAction={reopenAction}
            deferAction={deferAction}
          />
        ))}
      </ol>
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

function QuestionCard({
  question,
  canManage,
  decideAction,
  reopenAction,
  deferAction,
}: {
  question: Awaited<ReturnType<typeof getSignOffQuestions>>["questions"][number];
  canManage: boolean;
  decideAction: (formData: FormData) => Promise<void>;
  reopenAction: (formData: FormData) => Promise<void>;
  deferAction: (formData: FormData) => Promise<void>;
}) {
  const decided = question.status === "DECIDED";
  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wider text-ink/50">{question.code}</div>
          <h2 className="text-base font-medium leading-snug">{question.question}</h2>
          {question.prdAssumption && (
            <div className="mt-1 text-xs italic text-ink/60">
              PRD assumption: {question.prdAssumption}
            </div>
          )}
        </div>
        <span className={`tag ${STATUS_BADGE[question.status]}`}>{question.status}</span>
      </div>

      {decided && question.decision && (
        <div className="rounded border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-emerald-900/80">Decision</div>
          <div className="mt-0.5 whitespace-pre-wrap">{question.decision}</div>
          <div className="mt-2 text-xs text-emerald-900/70">
            {question.decidedByName ?? "—"}
            {question.decidedAt && (
              <> · {question.decidedAt.toISOString().slice(0, 10)}</>
            )}
          </div>
        </div>
      )}

      {question.notes && (
        <div className="rounded border border-ink/10 bg-ink/5 p-2 text-sm">
          <div className="text-xs uppercase tracking-wider text-ink/50">Notes</div>
          <div className="mt-0.5 whitespace-pre-wrap">{question.notes}</div>
        </div>
      )}

      {canManage && (
        <div className="space-y-3 rounded border border-ink/10 bg-ink/5 p-3">
          {!decided && (
            <form action={decideAction} className="space-y-2">
              <input type="hidden" name="code" value={question.code} />
              <label className="block text-sm">
                <div className="mb-1 text-xs text-ink/60">
                  Decision <span className="text-red-700">*</span>
                </div>
                <textarea
                  name="decision"
                  rows={3}
                  required
                  maxLength={4000}
                  className="input"
                  placeholder="The position we are signing off on, in the language we want recorded in the audit chain."
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <div className="mb-1 text-xs text-ink/60">Decided by (optional — defaults to you)</div>
                  <input
                    name="decidedByName"
                    maxLength={200}
                    className="input"
                    placeholder="e.g. Acumon Board, DPO, Legal"
                  />
                </label>
                <label className="block text-sm">
                  <div className="mb-1 text-xs text-ink/60">Notes (optional — links, paper refs)</div>
                  <input
                    name="notes"
                    maxLength={4000}
                    className="input"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="btn btn-primary text-xs">
                  Record decision
                </button>
              </div>
            </form>
          )}

          {decided && (
            <form action={reopenAction}>
              <input type="hidden" name="code" value={question.code} />
              <button type="submit" className="btn text-xs">
                Reopen — overrides the decision and writes a new audit event
              </button>
            </form>
          )}

          {!decided && question.status !== "DEFERRED" && (
            <form action={deferAction} className="flex flex-wrap items-end gap-2 border-t border-ink/10 pt-3">
              <input type="hidden" name="code" value={question.code} />
              <label className="block text-sm flex-1 min-w-[12rem]">
                <div className="mb-1 text-xs text-ink/60">Defer with note (optional)</div>
                <input
                  name="notes"
                  maxLength={4000}
                  className="input"
                  placeholder="e.g. Pushed to P2 pending vendor evaluation"
                />
              </label>
              <button type="submit" className="btn text-xs">
                Defer
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
