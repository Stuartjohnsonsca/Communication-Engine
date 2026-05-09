import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  decideQuestion,
  getSignOffQuestions,
  reopenQuestion,
  updateQuestion,
} from "@/lib/signoff";
import type { SignOffStatus } from "@prisma/client";

/**
 * PRD §18 — Open Questions for Sign-Off. Per-tenant: each Client has their
 * own copy of the ten enumerated questions and answers them for themselves.
 *
 * Security stack (defence in depth):
 *   1. NextAuth session must resolve to an ACTIVE membership in this tenant
 *      (`getTenantContext`). Cross-tenant access stops here.
 *   2. RBAC — `signoff:read` (FIRM_ADMIN, FCT_MEMBER) gates the page;
 *      `signoff:manage` (FIRM_ADMIN) gates each mutation.
 *   3. Server actions re-resolve the tenant context inside the action and
 *      re-check the role — never trust closure-captured `ctx` for auth.
 *   4. The lib helpers re-read the actor's membership and refuse if it's
 *      not on the claimed tenant.
 *   5. Postgres RLS on `SignOffQuestion` (see `prisma/rls.sql`) enforces
 *      row-level isolation independently of the WHERE clauses.
 *   6. Audit events are written into THIS tenant's chain.
 */

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
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "signoff:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getSignOffQuestions(ctx.tenant.id);
  const canManage = hasPermission(ctx.membership.role, "signoff:manage");

  async function decideAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "signoff:manage")) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const decidedByName = (formData.get("decidedByName") as string | null) ?? null;
    const notes = (formData.get("notes") as string | null) ?? null;

    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");
    if (!decision.trim()) throw new Error("decision text is required");

    await decideQuestion({
      tenantId: inner.tenant.id,
      code,
      decision,
      decidedByName,
      notes,
      actorMembershipId: inner.membership.id,
      actorName: inner.user.name ?? inner.user.email,
    });
    revalidatePath(`/${tenantSlug}/sign-off`);
  }

  async function reopenAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "signoff:manage")) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");

    await reopenQuestion({
      tenantId: inner.tenant.id,
      code,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/sign-off`);
  }

  async function deferAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "signoff:manage")) {
      throw new Error("forbidden");
    }

    const code = String(formData.get("code") ?? "");
    const notes = (formData.get("notes") as string | null) ?? null;
    if (!/^Q-\d{2}$/.test(code)) throw new Error("invalid code");

    await updateQuestion({
      tenantId: inner.tenant.id,
      code,
      status: "DEFERRED",
      notes,
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
          PRD §18 — the {view.summary.total} questions {ctx.tenant.name} needs to answer
          before going live. Each tenant maintains their own answers privately; decisions
          recorded here are written to this tenant&apos;s audit chain.
        </p>
      </div>

      <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total" value={String(view.summary.total)} />
        <Stat label="Open" value={String(view.summary.byStatus.OPEN)} />
        <Stat label="Decided" value={String(view.summary.byStatus.DECIDED)} />
        <Stat label="Deferred" value={String(view.summary.byStatus.DEFERRED)} />
      </div>

      {!canManage && (
        <div className="card text-xs text-ink/60">
          Read-only view. Recording or reopening decisions is restricted to the Firm
          Administrator.
        </div>
      )}

      {remaining === 0 && view.summary.byStatus.DEFERRED === 0 && (
        <div className="card border-emerald-300 bg-emerald-50/60 text-sm text-emerald-900">
          All sign-off questions have an explicit decision recorded for {ctx.tenant.name}. The audit chain captures who decided what and when.
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
                    placeholder="e.g. Board, DPO, Legal"
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
