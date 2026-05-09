import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  addCohortMember,
  concludeSandbox,
  getSandboxView,
  provisionSandbox,
} from "@/lib/sandbox";
import type { SandboxOutcome } from "@prisma/client";

const OUTCOME_BADGE: Record<SandboxOutcome, string> = {
  PENDING: "bg-sky-100 text-sky-800",
  PROMOTED: "bg-emerald-100 text-emerald-800",
  ITERATING: "bg-amber-100 text-amber-900",
  DECLINED: "bg-ink/10 text-ink/60",
};

export default async function SandboxPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "sandbox:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }
  if (ctx.tenant.isSandbox) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sandbox</h1>
        <p className="text-sm text-ink/70">
          You&rsquo;re inside the sandbox tenant. The sandbox lifecycle is managed from the parent
          tenant&rsquo;s admin area.
        </p>
      </div>
    );
  }

  const view = await getSandboxView(ctx.tenant.id);
  const canManage = hasPermission(ctx.membership.role, "sandbox:manage");

  async function provisionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "sandbox:manage")) throw new Error("forbidden");
    const durationDays = Number(formData.get("durationDays") ?? 30);
    const cohortLimit = Number(formData.get("cohortLimit") ?? 10);
    await provisionSandbox({
      parentTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      durationDays,
      cohortLimit,
    });
    revalidatePath(`/${tenantSlug}/admin/sandbox`);
  }

  async function addMemberAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "sandbox:manage")) throw new Error("forbidden");
    const sandboxTenantId = String(formData.get("sandboxTenantId") ?? "");
    const email = String(formData.get("email") ?? "");
    const role = String(formData.get("role") ?? "USER") as "USER" | "FCT_MEMBER" | "FIRM_ADMIN";
    await addCohortMember({
      sandboxTenantId,
      parentTenantId: inner.tenant.id,
      email,
      role,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/sandbox`);
  }

  async function concludeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "sandbox:manage")) throw new Error("forbidden");
    const sandboxTenantId = String(formData.get("sandboxTenantId") ?? "");
    const outcome = String(formData.get("outcome") ?? "") as
      | "PROMOTED"
      | "ITERATING"
      | "DECLINED";
    const byName = String(formData.get("byName") ?? "");
    const notes = String(formData.get("notes") ?? "").trim() || null;
    const promotedFcgId = String(formData.get("promotedFcgId") ?? "").trim() || undefined;
    await concludeSandbox({
      sandboxTenantId,
      parentTenantId: inner.tenant.id,
      outcome,
      byName,
      notes,
      promotedFcgId,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/sandbox`);
  }

  const sandbox = view.sandbox;
  const isOpen = sandbox?.sandboxOutcome === "PENDING";
  const closesAt = sandbox?.sandboxClosesAt;
  const elapsed = closesAt ? closesAt.getTime() < Date.now() : false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sandbox</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §14.2 — provision a Sandbox tenant alongside production for a small cohort
          (default 10 users) and a fixed window (default 30 days). The sandbox produces a
          candidate FCG and sample drafts; production communications are unaffected. On
          conclusion you promote, iterate, or decline.
        </p>
      </div>

      {!sandbox && (
        <section className="card space-y-3">
          <h2 className="text-base font-medium">No sandbox open</h2>
          <p className="text-sm text-ink/70">
            Provision a sandbox to dry-run drafting + FCG flows with a limited cohort before
            opening to the wider firm.
          </p>
          {canManage && (
            <form action={provisionAction} className="grid gap-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-xs text-ink/60">Duration (days, max 180)</span>
                  <input className="input" name="durationDays" type="number" defaultValue={30} min={1} max={180} />
                </label>
                <label className="grid gap-1">
                  <span className="text-xs text-ink/60">Cohort limit (max 50)</span>
                  <input className="input" name="cohortLimit" type="number" defaultValue={10} min={1} max={50} />
                </label>
              </div>
              <button className="btn btn-primary justify-self-start" type="submit">
                Provision sandbox
              </button>
            </form>
          )}
        </section>
      )}

      {sandbox && (
        <>
          <section className="card space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-base font-medium">{sandbox.name}</h2>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
                  <span className={`tag ${OUTCOME_BADGE[sandbox.sandboxOutcome]}`}>
                    {sandbox.sandboxOutcome.toLowerCase()}
                  </span>
                  <span>
                    slug <code className="rounded bg-ink/5 px-1">{sandbox.slug}</code>
                  </span>
                  {sandbox.sandboxOpenedAt && (
                    <span>opened {sandbox.sandboxOpenedAt.toISOString().slice(0, 10)}</span>
                  )}
                  {closesAt && (
                    <span>
                      {elapsed && isOpen ? "elapsed at" : "closes"} {closesAt.toISOString().slice(0, 10)}
                    </span>
                  )}
                  <span>
                    cohort {view.cohort.length} / {sandbox.sandboxCohortLimit}
                  </span>
                </div>
              </div>
              {sandbox.status !== "TERMINATED" && (
                <Link
                  href={`/${sandbox.slug}/dashboard`}
                  className="btn"
                >
                  Open sandbox →
                </Link>
              )}
            </div>

            {sandbox.sandboxOutcome !== "PENDING" && (
              <div className="rounded bg-ink/5 p-3 text-sm">
                <div className="text-ink/80">
                  Concluded {sandbox.sandboxOutcomeAt?.toISOString().slice(0, 10) ?? "—"} by{" "}
                  {sandbox.sandboxOutcomeByName ?? "—"}.
                </div>
                {sandbox.sandboxOutcomeNotes && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-ink/60">
                    {sandbox.sandboxOutcomeNotes}
                  </p>
                )}
                {sandbox.sandboxPromotedProposalId && (
                  <p className="mt-1 text-xs text-ink/60">
                    Staged as FCG proposal{" "}
                    <Link
                      href={`/${tenantSlug}/fcg/proposals/${sandbox.sandboxPromotedProposalId}`}
                      className="underline decoration-dotted"
                    >
                      {sandbox.sandboxPromotedProposalId.slice(0, 8)}…
                    </Link>{" "}
                    on the parent — the FCT will vote through the normal §6 governance flow.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="card space-y-3">
            <h3 className="text-base font-medium">Cohort ({view.cohort.length})</h3>
            {view.cohort.length === 0 ? (
              <p className="text-sm text-ink/60">No members in the cohort yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {view.cohort.map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0">
                    <span>
                      {m.user.name ?? m.user.email}{" "}
                      <span className="text-ink/50">&lt;{m.user.email}&gt;</span>
                    </span>
                    <span className="text-xs text-ink/50">
                      <span className="tag mr-1">{m.role}</span>
                      {m.status.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canManage && isOpen && (
              <form action={addMemberAction} className="grid gap-2 border-t border-ink/10 pt-3 text-sm">
                <input type="hidden" name="sandboxTenantId" value={sandbox.id} />
                <div className="grid grid-cols-[2fr_1fr_auto] gap-2">
                  <input
                    className="input"
                    name="email"
                    type="email"
                    placeholder="user@example.com"
                    required
                    maxLength={200}
                  />
                  <select className="input" name="role" defaultValue="USER">
                    <option value="USER">USER</option>
                    <option value="FCT_MEMBER">FCT_MEMBER</option>
                    <option value="FIRM_ADMIN">FIRM_ADMIN</option>
                  </select>
                  <button className="btn btn-primary" type="submit">
                    Add
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="card space-y-3">
            <h3 className="text-base font-medium">FCG candidates ({view.fcgCandidates.length})</h3>
            {view.fcgCandidates.length === 0 ? (
              <p className="text-sm text-ink/60">No FCG drafted in the sandbox yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {view.fcgCandidates.map((f) => (
                  <li key={f.id} className="flex items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0">
                    <span>
                      v{f.version} · {f.ruleCount} rule{f.ruleCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-ink/50">
                      <span className="tag mr-1">{f.status.toLowerCase()}</span>
                      <code className="text-ink/40">{f.id.slice(0, 8)}…</code>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManage && isOpen && (
            <section className="card space-y-3">
              <h3 className="text-base font-medium">Conclude</h3>
              <p className="text-xs text-ink/60">
                Promote a candidate FCG (lifts to a §6 proposal on the parent for normal voting),
                iterate (close the window; open another later), or decline (terminates the sandbox
                tenant — cohort can no longer log in).
              </p>
              <form action={concludeAction} className="grid gap-2 text-sm">
                <input type="hidden" name="sandboxTenantId" value={sandbox.id} />
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs text-ink/60">Outcome</span>
                    <select className="input" name="outcome" defaultValue="ITERATING">
                      <option value="PROMOTED">Promote candidate FCG</option>
                      <option value="ITERATING">Iterate</option>
                      <option value="DECLINED">Decline</option>
                    </select>
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs text-ink/60">Signed by (name)</span>
                    <input className="input" name="byName" required maxLength={200} />
                  </label>
                </div>
                <label className="grid gap-1">
                  <span className="text-xs text-ink/60">
                    FCG to promote (id — required if outcome = PROMOTED)
                  </span>
                  <input className="input" name="promotedFcgId" placeholder={view.fcgCandidates[0]?.id ?? ""} />
                </label>
                <textarea
                  className="input"
                  name="notes"
                  rows={3}
                  placeholder="Notes (optional)"
                  maxLength={4000}
                />
                <button className="btn btn-primary justify-self-start" type="submit">
                  Record outcome
                </button>
              </form>
            </section>
          )}
        </>
      )}
    </div>
  );
}
