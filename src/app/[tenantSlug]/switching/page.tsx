import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  addSubProcessor,
  getSubProcessors,
  isAcumonOperator,
  setSubProcessorActive,
  updateSubProcessor,
} from "@/lib/switching";

export default async function SwitchingPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "switching:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getSubProcessors();
  const isOperator =
    isAcumonOperator(ctx.tenant.slug) &&
    hasPermission(ctx.membership.role, "subprocessors:manage");

  async function addAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    await addSubProcessor({
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      role: String(formData.get("role") ?? ""),
      jurisdiction: String(formData.get("jurisdiction") ?? ""),
      dataCategories: String(formData.get("dataCategories") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      contractRef: String(formData.get("contractRef") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function updateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    const code = String(formData.get("code") ?? "");
    const dataCategoriesRaw = formData.get("dataCategories");
    await updateSubProcessor({
      code,
      name: String(formData.get("name") ?? "") || undefined,
      role: String(formData.get("role") ?? "") || undefined,
      jurisdiction: String(formData.get("jurisdiction") ?? "") || undefined,
      dataCategories:
        typeof dataCategoriesRaw === "string"
          ? dataCategoriesRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      contractRef: String(formData.get("contractRef") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function setActiveAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    await setSubProcessorActive({
      code: String(formData.get("code") ?? ""),
      active: formData.get("active") === "true",
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Switching and lock-in posture</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §15.3 — published in advance of contracting so prospective Clients can audit the
          stack and the exit path before committing.
        </p>
      </div>

      <section className="card space-y-2 border-emerald-300 bg-emerald-50/40">
        <h2 className="text-base font-medium">Three commitments</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            <strong>Sub-processor list, integration APIs and export schemas published in
            advance.</strong> See below + the integrations and exports sections.
          </li>
          <li>
            <strong>No switching charges after January 2027,</strong> in line with the EU Data
            Act (Regulation 2023/2854).
          </li>
          <li>
            <strong>Customer data exportable on demand at no charge during the contract.</strong>{" "}
            Use{" "}
            <Link href={`/${tenantSlug}/admin/termination`} className="underline decoration-dotted">
              the termination page
            </Link>{" "}
            to generate a fresh JSON snapshot at any time — works whether or not you&rsquo;ve
            actually noticed termination.
          </li>
        </ol>
      </section>

      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Sub-processors ({view.active.length})</h2>
          {!isOperator && (
            <span className="text-xs text-ink/50">Read-only — managed by Acumon Intelligence.</span>
          )}
        </div>

        {view.active.length === 0 ? (
          <p className="text-sm text-ink/60">No sub-processors recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {view.active.map((s) => (
              <li key={s.id} className="rounded border border-ink/10 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 text-xs text-ink/50">
                      <code className="rounded bg-ink/5 px-1">{s.code}</code> ·{" "}
                      {s.jurisdiction}
                    </span>
                  </div>
                  <span className="text-xs text-ink/50">
                    added {s.addedAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                <p className="mt-1 text-sm">{s.role}</p>
                {s.dataCategories.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.dataCategories.map((c) => (
                      <span key={c} className="tag bg-ink/5 text-xs">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                {s.contractRef && (
                  <div className="mt-1 text-xs text-ink/50">
                    Contract: <code className="rounded bg-ink/5 px-1">{s.contractRef}</code>
                  </div>
                )}
                {s.notes && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-ink/60">{s.notes}</p>
                )}
                {isOperator && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-ink/60">Edit / remove</summary>
                    <form action={updateAction} className="mt-2 grid gap-1 text-sm">
                      <input type="hidden" name="code" value={s.code} />
                      <input className="input" name="name" defaultValue={s.name} required />
                      <input className="input" name="role" defaultValue={s.role} required />
                      <input className="input" name="jurisdiction" defaultValue={s.jurisdiction} required />
                      <input
                        className="input"
                        name="dataCategories"
                        defaultValue={s.dataCategories.join(", ")}
                        placeholder="Comma-separated"
                      />
                      <input
                        className="input"
                        name="contractRef"
                        defaultValue={s.contractRef ?? ""}
                        placeholder="Contract reference"
                      />
                      <textarea className="input" name="notes" rows={2} defaultValue={s.notes ?? ""} />
                      <button className="btn justify-self-start" type="submit">
                        Save
                      </button>
                    </form>
                    <form action={setActiveAction} className="mt-2 grid gap-1 text-sm">
                      <input type="hidden" name="code" value={s.code} />
                      <input type="hidden" name="active" value="false" />
                      <input
                        className="input"
                        name="notes"
                        placeholder="Reason for removal"
                      />
                      <button className="btn justify-self-start" type="submit">
                        Mark removed
                      </button>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}

        {isOperator && (
          <details className="border-t border-ink/10 pt-3">
            <summary className="cursor-pointer text-sm font-medium">Add sub-processor</summary>
            <form action={addAction} className="mt-2 grid gap-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="input"
                  name="code"
                  required
                  placeholder="stable-code"
                  pattern="[a-z0-9_-]+"
                  maxLength={64}
                />
                <input className="input" name="name" required placeholder="Display name" maxLength={200} />
              </div>
              <input
                className="input"
                name="role"
                required
                placeholder="Role (e.g. LLM provider — drafting agents)"
                maxLength={200}
              />
              <input
                className="input"
                name="jurisdiction"
                required
                placeholder="Jurisdiction (e.g. US, EU-IE, UK)"
                maxLength={64}
              />
              <input
                className="input"
                name="dataCategories"
                placeholder="Data categories (comma-separated)"
              />
              <input className="input" name="contractRef" placeholder="Contract reference (optional)" />
              <textarea className="input" name="notes" rows={2} placeholder="Notes (optional)" />
              <button className="btn btn-primary justify-self-start" type="submit">
                Add
              </button>
            </form>
          </details>
        )}
      </section>

      {view.inactive.length > 0 && (
        <section className="card space-y-2">
          <h3 className="text-base font-medium">Removed ({view.inactive.length})</h3>
          <ul className="space-y-1 text-sm">
            {view.inactive.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0 opacity-60"
              >
                <span>
                  {s.name} <span className="text-xs text-ink/40">— {s.role}</span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  <span>removed {s.removedAt?.toISOString().slice(0, 10) ?? "—"}</span>
                  {isOperator && (
                    <form action={setActiveAction} className="inline">
                      <input type="hidden" name="code" value={s.code} />
                      <input type="hidden" name="active" value="true" />
                      <button className="underline decoration-dotted" type="submit">
                        Reinstate
                      </button>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Integration APIs (PRD §10)</h2>
        <p className="text-sm text-ink/70">
          The integrations catalogue — every Tier 1 / 2 / 3 target plus the §10.4 generic SDK
          commitment, with required scopes and delivery status — lives at{" "}
          <Link
            href={`/${tenantSlug}/integrations`}
            className="underline decoration-dotted"
          >
            /integrations
          </Link>
          . Your tenant&rsquo;s actual authorisations are in{" "}
          <Link
            href={`/${tenantSlug}/admin/channels`}
            className="underline decoration-dotted"
          >
            channel administration
          </Link>
          .
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Export schema</h2>
        <p className="text-sm text-ink/70">
          The on-demand export uses the schema{" "}
          <code className="rounded bg-ink/5 px-1">acumon.termination-export@1</code> with these
          top-level keys:
        </p>
        <ul className="grid gap-1 pl-5 text-sm md:grid-cols-2">
          <li className="list-disc">
            <code className="text-ink/70">meta</code> — schema id, generation timestamp, tenant
          </li>
          <li className="list-disc">
            <code className="text-ink/70">counts</code> — per-collection row totals
          </li>
          <li className="list-disc">
            <code className="text-ink/70">members</code>, <code className="text-ink/70">fcgs</code>,{" "}
            <code className="text-ink/70">ucgs</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">drafts</code>, <code className="text-ink/70">actions</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">meetings</code>, <code className="text-ink/70">meetingRecords</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">auditEvents</code> (hash-chained per §6.2)
          </li>
          <li className="list-disc">
            <code className="text-ink/70">dpiaAttestations</code>, <code className="text-ink/70">dsarRequests</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">billingPeriods</code>,{" "}
            <code className="text-ink/70">billingSnapshots</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">signOffQuestions</code>,{" "}
            <code className="text-ink/70">channels</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">ingestedMessages</code>,{" "}
            <code className="text-ink/70">opportunityCandidates</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">sentimentSignals</code>,{" "}
            <code className="text-ink/70">adherenceScores</code>
          </li>
          <li className="list-disc">
            <code className="text-ink/70">termsRecords</code> (MSA / DPA / AUP / SLA versions per §15.4)
          </li>
        </ul>
        <p className="text-xs text-ink/60">
          All values are JSON-portable (BigInt audit sequences are emitted as strings).
        </p>
      </section>
    </div>
  );
}
