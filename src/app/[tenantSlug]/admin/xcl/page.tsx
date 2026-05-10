import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  getClientView,
  getCuratorView,
  isAcumonOperator,
  recordReidentificationTest,
  reviewCandidate,
  setOptIn,
  type CuratorView,
} from "@/lib/xcl";
import type { XclCandidate, XclCandidateStatus, XclInsightKind } from "@prisma/client";

const STATUS_BADGE: Record<XclCandidateStatus, string> = {
  PENDING: "bg-sky-100 text-sky-800",
  APPROVED: "bg-amber-100 text-amber-900",
  REJECTED: "bg-ink/10 text-ink/60",
  COMMITTED: "bg-emerald-100 text-emerald-800",
};

const KIND_LABEL: Record<XclInsightKind, string> = {
  FCG_AMENDMENT: "FCG amendment",
  OPPORTUNITY_RULE: "Opportunity rule",
  JUDGE_PROMPT: "Judge prompt",
};

export default async function XclPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "xcl:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const isCurator =
    isAcumonOperator(ctx.tenant.slug) && hasPermission(ctx.membership.role, "xcl:curate");

  const [clientView, curatorView] = await Promise.all([
    getClientView(ctx.tenant.id),
    isCurator ? getCuratorView() : Promise.resolve(null),
  ]);

  async function optInAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "xcl:opt-in")) throw new Error("forbidden");

    const optIn = formData.get("optIn") === "true";
    const signedByName = String(formData.get("signedByName") ?? "").trim() || null;
    const addendumRef = String(formData.get("addendumRef") ?? "").trim() || null;
    const reason = String(formData.get("reason") ?? "").trim() || null;
    await setOptIn({
      tenantId: inner.tenant.id,
      optIn,
      signedByName,
      addendumRef,
      reason,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/xcl`);
  }

  async function reviewAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "xcl:curate")) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug)) throw new Error("Acumon-side only");
    const candidateId = String(formData.get("candidateId") ?? "");
    const decision = String(formData.get("decision") ?? "") as "APPROVE" | "REJECT" | "COMMIT";
    const notes = String(formData.get("notes") ?? "").trim() || null;
    await reviewCandidate({
      candidateId,
      decision,
      notes,
      curatorTenantId: inner.tenant.id,
      curatorMembershipId: inner.membership.id,
      curatorName: inner.user.name ?? inner.user.email,
    });
    revalidatePath(`/${tenantSlug}/admin/xcl`);
  }

  async function reidTestAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "xcl:curate")) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug)) throw new Error("Acumon-side only");
    const quarter = String(formData.get("quarter") ?? "");
    const conductedAt = new Date(String(formData.get("conductedAt") ?? ""));
    const conductedByName = String(formData.get("conductedByName") ?? "");
    const externalReviewer = formData.get("externalReviewer") === "true";
    const sampleSize = Number(formData.get("sampleSize") ?? 0);
    const reidentifiedCount = Number(formData.get("reidentifiedCount") ?? 0);
    const summary = String(formData.get("summary") ?? "");
    const notes = String(formData.get("notes") ?? "").trim() || null;
    await recordReidentificationTest({
      quarter,
      conductedAt,
      conductedByName,
      externalReviewer,
      sampleSize,
      reidentifiedCount,
      summary,
      notes,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/xcl`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cross-Client Learning</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §11 — opt-in pipeline that anonymises insights from your tenant and feeds them to
          Acumon&rsquo;s curator before they enter global model defaults. Every candidate is
          auto-redacted, human-reviewed, and re-identification tested quarterly.
        </p>
      </div>

      <ClientCard
        view={clientView}
        canManage={hasPermission(ctx.membership.role, "xcl:opt-in")}
        action={optInAction}
      />

      {isCurator && curatorView && (
        <CuratorPanel
          view={curatorView}
          reviewAction={reviewAction}
          reidTestAction={reidTestAction}
        />
      )}
    </div>
  );
}

function ClientCard({
  view,
  canManage,
  action,
}: {
  view: Awaited<ReturnType<typeof getClientView>>;
  canManage: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Your tenant</h2>
        <span className={`tag ${view.optedIn ? "bg-emerald-100 text-emerald-800" : "bg-ink/10 text-ink/60"}`}>
          {view.optedIn ? "opted in" : "not opted in"}
        </span>
      </div>

      {view.optedIn ? (
        <p className="text-sm text-ink/70">
          Signed by {view.optedInByName ?? "—"} on{" "}
          {view.optedInAt?.toISOString().slice(0, 10) ?? "—"} · addendum{" "}
          <code className="rounded bg-ink/5 px-1 text-xs">{view.addendumRef ?? "—"}</code>.
          Insights from your tenant flow into the curator queue redacted; nothing leaves the
          tenant boundary unless approved by an Acumon Curator.
        </p>
      ) : view.optedOutAt ? (
        <p className="text-sm text-ink/70">
          Opted out on {view.optedOutAt.toISOString().slice(0, 10)}. No new insights from your
          tenant will be queued for the curator pipeline.
        </p>
      ) : (
        <p className="text-sm text-ink/70">
          Cross-Client Learning is opt-in via a separate addendum to your Order Form (PRD §11.2).
          Opting in entitles your tenant to a discount on the Sales Identifier add-on.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-2 text-xs text-ink/60 sm:grid-cols-4">
        <div className="rounded bg-ink/5 p-2">
          <dt>Pending</dt>
          <dd className="text-base font-medium text-ink">{view.counts.PENDING}</dd>
        </div>
        <div className="rounded bg-ink/5 p-2">
          <dt>Approved</dt>
          <dd className="text-base font-medium text-ink">{view.counts.APPROVED}</dd>
        </div>
        <div className="rounded bg-ink/5 p-2">
          <dt>Rejected</dt>
          <dd className="text-base font-medium text-ink">{view.counts.REJECTED}</dd>
        </div>
        <div className="rounded bg-ink/5 p-2">
          <dt>Committed</dt>
          <dd className="text-base font-medium text-ink">{view.counts.COMMITTED}</dd>
        </div>
      </dl>

      {canManage && (
        <form action={action} className="grid gap-2 border-t border-ink/10 pt-3 text-sm">
          {!view.optedIn ? (
            <>
              <input type="hidden" name="optIn" value="true" />
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Signed by (name)</span>
                <input
                  className="input"
                  name="signedByName"
                  required
                  placeholder="Jane Smith, DPO"
                  maxLength={200}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Addendum reference</span>
                <input
                  className="input"
                  name="addendumRef"
                  required
                  placeholder="XCL-ADDENDUM-2026-01"
                  maxLength={200}
                />
              </label>
              <button className="btn btn-primary justify-self-start" type="submit">
                Record opt-in
              </button>
            </>
          ) : (
            <>
              <input type="hidden" name="optIn" value="false" />
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Reason for opt-out (optional)</span>
                <input className="input" name="reason" maxLength={2000} />
              </label>
              <button className="btn justify-self-start" type="submit">
                Opt out
              </button>
            </>
          )}
        </form>
      )}
    </section>
  );
}

function CuratorPanel({
  view,
  reviewAction,
  reidTestAction,
}: {
  view: CuratorView;
  reviewAction: (formData: FormData) => Promise<void>;
  reidTestAction: (formData: FormData) => Promise<void>;
}) {
  const decided = view.rejectionRate.decided;
  const rejected = view.rejectionRate.rejected;
  const ratePct = decided > 0 ? Math.round((rejected / decided) * 100) : null;

  return (
    <section className="space-y-6">
      <div className="card">
        <h2 className="text-lg font-medium">Curator console</h2>
        <p className="mt-1 text-sm text-ink/70">
          Acumon-side. PRD §11.3 anonymisation pipeline + human curator + quarterly
          re-identification testing.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-ink/60 sm:grid-cols-3">
          <div className="rounded bg-ink/5 p-2">
            <dt>Pending review</dt>
            <dd className="text-base font-medium text-ink">{view.pending.length}</dd>
          </div>
          <div className="rounded bg-ink/5 p-2">
            <dt>Approved (awaiting commit)</dt>
            <dd className="text-base font-medium text-ink">{view.approved.length}</dd>
          </div>
          <div className="rounded bg-ink/5 p-2">
            <dt>Rejection rate</dt>
            <dd className="text-base font-medium text-ink">
              {ratePct != null ? `${ratePct}% (${rejected}/${decided})` : "n/a"}
            </dd>
          </div>
        </dl>
      </div>

      <CandidateList
        title={`Pending (${view.pending.length})`}
        candidates={view.pending}
        actions={["APPROVE", "REJECT"]}
        action={reviewAction}
      />
      <CandidateList
        title={`Approved — ready to commit (${view.approved.length})`}
        candidates={view.approved}
        actions={["COMMIT", "REJECT"]}
        action={reviewAction}
      />

      <RecentList candidates={view.recent} />

      <ReidTestPanel tests={view.reidTests} action={reidTestAction} />
    </section>
  );
}

function CandidateList({
  title,
  candidates,
  actions,
  action,
}: {
  title: string;
  candidates: XclCandidate[];
  actions: ("APPROVE" | "REJECT" | "COMMIT")[];
  action: (formData: FormData) => Promise<void>;
}) {
  if (candidates.length === 0) {
    return (
      <div className="card">
        <h3 className="text-base font-medium">{title}</h3>
        <p className="mt-2 text-sm text-ink/60">Nothing here right now.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h3 className="text-base font-medium">{title}</h3>
      <ul className="mt-3 space-y-3">
        {candidates.map((c) => {
          const log = (c.redactionLog as unknown as { kind: string; original: string; replacement: string }[]) ?? [];
          return (
            <li key={c.id} className="rounded border border-ink/10 p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className={`tag mr-2 ${STATUS_BADGE[c.status]}`}>{c.status.toLowerCase()}</span>
                  <span className="font-medium">{KIND_LABEL[c.kind]}</span>
                  <span className="ml-2 text-xs text-ink/50">
                    src tenant <code className="rounded bg-ink/5 px-1">{c.sourceTenantId.slice(0, 8)}…</code>{" "}
                    · {c.sourceSubjectType} {c.sourceSubjectId.slice(0, 8)}…
                  </span>
                </div>
                <span className="text-xs text-ink/50">
                  {c.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </div>
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-ink/5 p-2 text-xs">
                {c.redactedText}
              </pre>
              {log.length > 0 && (
                <details className="mt-1 text-xs text-ink/60">
                  <summary className="cursor-pointer">Redaction log ({log.length})</summary>
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {log.map((entry, i) => (
                      <li key={i}>
                        <span className="tag mr-1 bg-ink/5">{entry.kind}</span>
                        <code className="text-ink/40 line-through">{entry.original}</code>{" "}
                        → <code>{entry.replacement}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="candidateId" value={c.id} />
                <input
                  className="input flex-1 min-w-[14rem]"
                  type="text"
                  name="notes"
                  placeholder="Curator notes (optional)"
                  maxLength={2000}
                />
                {actions.map((a) => (
                  <button
                    key={a}
                    className={a === "REJECT" ? "btn" : "btn btn-primary"}
                    type="submit"
                    name="decision"
                    value={a}
                  >
                    {a.toLowerCase()}
                  </button>
                ))}
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentList({ candidates }: { candidates: XclCandidate[] }) {
  if (candidates.length === 0) return null;
  return (
    <div className="card">
      <h3 className="text-base font-medium">Recent activity</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {candidates.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0">
            <span>
              <span className={`tag mr-2 ${STATUS_BADGE[c.status]}`}>{c.status.toLowerCase()}</span>
              <span className="text-ink/80">{KIND_LABEL[c.kind]}</span>
              {c.committedByName && <span className="ml-2 text-xs text-ink/50">by {c.committedByName}</span>}
            </span>
            <span className="text-xs text-ink/50">
              {c.updatedAt.toISOString().slice(0, 16).replace("T", " ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReidTestPanel({
  tests,
  action,
}: {
  tests: CuratorView["reidTests"];
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="card space-y-3">
      <h3 className="text-base font-medium">Re-identification tests (PRD §11.3)</h3>
      {tests.length === 0 ? (
        <p className="text-sm text-ink/60">No tests recorded yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {tests.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0">
              <span>
                <span className="tag mr-2">{t.quarter}</span>
                <span className="text-ink/80">{t.conductedByName}</span>
                {t.externalReviewer && <span className="tag ml-2 bg-violet-100">external</span>}
                {" — "}
                <span className={t.reidentifiedCount > 0 ? "text-red-700" : "text-ink/60"}>
                  {t.reidentifiedCount}/{t.sampleSize} re-identified
                </span>
              </span>
              <span className="text-xs text-ink/50">
                {t.conductedAt.toISOString().slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form action={action} className="grid gap-2 border-t border-ink/10 pt-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <input className="input" name="quarter" required placeholder="2026-Q2" pattern="\d{4}-Q[1-4]" />
          <input className="input" name="conductedAt" required type="date" />
        </div>
        <input className="input" name="conductedByName" required placeholder="Reviewer name" maxLength={200} />
        <div className="grid grid-cols-3 gap-2">
          <label className="flex items-center gap-2 text-xs text-ink/70">
            <input type="checkbox" name="externalReviewer" value="true" defaultChecked /> external reviewer
          </label>
          <input className="input" name="sampleSize" required type="number" min={1} placeholder="sample" />
          <input className="input" name="reidentifiedCount" required type="number" min={0} defaultValue={0} />
        </div>
        <textarea className="input" name="summary" required rows={3} placeholder="Summary of the test and findings" maxLength={4000} />
        <textarea className="input" name="notes" rows={2} placeholder="Notes (optional)" maxLength={4000} />
        <button className="btn btn-primary justify-self-start" type="submit">
          Record test
        </button>
      </form>
    </div>
  );
}
