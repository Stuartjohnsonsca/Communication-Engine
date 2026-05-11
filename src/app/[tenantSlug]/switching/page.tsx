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
import {
  announceChange,
  cancelChange,
  confirmChange,
  DEFAULT_NOTICE_DAYS,
  getChange,
  getObjectionForTenant,
  listObjectionsForChange,
  listPendingChanges,
  raiseObjection,
  SubProcessorChangeValidationError,
  withdrawObjection,
} from "@/lib/subprocessors";

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
  const isClient = !isAcumonOperator(ctx.tenant.slug);
  const canObject =
    isClient && hasPermission(ctx.membership.role, "subprocessor-objections:raise");

  const pendingChanges = await listPendingChanges();
  const pendingObjectionsByChange = new Map<
    string,
    Awaited<ReturnType<typeof listObjectionsForChange>>
  >();
  const tenantObjectionByChange = new Map<
    string,
    Awaited<ReturnType<typeof getObjectionForTenant>>
  >();
  if (pendingChanges.length > 0) {
    if (isOperator) {
      for (const c of pendingChanges) {
        pendingObjectionsByChange.set(c.id, await listObjectionsForChange(c.id));
      }
    }
    if (isClient) {
      for (const c of pendingChanges) {
        tenantObjectionByChange.set(c.id, await getObjectionForTenant(ctx.tenant.id, c.id));
      }
    }
  }

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

  // ─── Item 24 actions: announce / cancel / confirm / object / withdraw ───

  async function announceAddAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    const days = Math.max(1, Math.min(365, Number(formData.get("noticeDays") ?? DEFAULT_NOTICE_DAYS) || DEFAULT_NOTICE_DAYS));
    const effectiveAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    try {
      await announceChange({
        kind: "ADDED",
        description: String(formData.get("description") ?? ""),
        effectiveAt,
        subProcessor: {
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
        },
        actorTenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
      });
    } catch (err) {
      if (err instanceof SubProcessorChangeValidationError) {
        throw new Error(`Announce failed: ${err.message}`);
      }
      throw err;
    }
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function announceExistingAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    const kindRaw = String(formData.get("kind") ?? "");
    if (kindRaw !== "REMOVED" && kindRaw !== "MATERIAL_UPDATE") {
      throw new Error("invalid kind");
    }
    const days = Math.max(1, Math.min(365, Number(formData.get("noticeDays") ?? DEFAULT_NOTICE_DAYS) || DEFAULT_NOTICE_DAYS));
    const effectiveAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    try {
      await announceChange({
        kind: kindRaw,
        description: String(formData.get("description") ?? ""),
        effectiveAt,
        subProcessorCode: String(formData.get("code") ?? ""),
        actorTenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
      });
    } catch (err) {
      if (err instanceof SubProcessorChangeValidationError) {
        throw new Error(`Announce failed: ${err.message}`);
      }
      throw err;
    }
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function cancelChangeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    await cancelChange({
      changeId: String(formData.get("changeId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function confirmChangeNowAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!isAcumonOperator(inner.tenant.slug) || !hasPermission(inner.membership.role, "subprocessors:manage")) {
      throw new Error("forbidden");
    }
    const changeId = String(formData.get("changeId") ?? "");
    const change = await getChange(changeId);
    if (!change) throw new Error("change not found");
    const noticeOverride = change.effectiveAt > new Date();
    await confirmChange({
      changeId,
      noticeOverride,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function raiseObjectionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "subprocessor-objections:raise")) {
      throw new Error("forbidden");
    }
    if (isAcumonOperator(inner.tenant.slug)) {
      throw new Error("Acumon-tenant FIRM_ADMINs cannot raise objections to their own changes");
    }
    await raiseObjection({
      tenantId: inner.tenant.id,
      subProcessorChangeId: String(formData.get("changeId") ?? ""),
      raisedByMembershipId: inner.membership.id,
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(`/${tenantSlug}/switching`);
  }

  async function withdrawObjectionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "subprocessor-objections:raise")) {
      throw new Error("forbidden");
    }
    await withdrawObjection({
      tenantId: inner.tenant.id,
      objectionId: String(formData.get("objectionId") ?? ""),
      withdrawnByMembershipId: inner.membership.id,
      reason: String(formData.get("reason") ?? "").trim() || null,
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

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Public surface</h2>
        <p className="text-sm text-ink/70">
          The same sub-processor list, recent incident posture, accessibility statement and
          terms-versioning summary are mirrored at{" "}
          <Link href="/status" className="underline decoration-dotted">
            /status
          </Link>{" "}
          for procurement reviewers and prospective Clients to read without an account.
        </p>
      </section>

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

      {pendingChanges.length > 0 && (
        <section className="card space-y-3 border-amber-300 bg-amber-50/40">
          <div>
            <h2 className="text-base font-medium">
              Pending sub-processor changes ({pendingChanges.length})
            </h2>
            <p className="mt-1 text-xs text-ink/60">
              DPA art. 28(2)(a) notice window. Each change takes effect on the earliest effective
              date below unless cancelled. Clients may raise an objection at any point before the
              effective date — objections are non-blocking but are recorded on the tenant&rsquo;s
              audit chain.
            </p>
          </div>
          <ul className="space-y-3">
            {pendingChanges.map((c) => {
              const objections = pendingObjectionsByChange.get(c.id) ?? [];
              const ownObjection = tenantObjectionByChange.get(c.id) ?? null;
              const verb =
                c.kind === "ADDED"
                  ? "Adding"
                  : c.kind === "REMOVED"
                    ? "Removing"
                    : "Material change to";
              return (
                <li key={c.id} className="rounded border border-ink/10 bg-white p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-medium">
                        {verb} {c.subProcessor.name}
                      </span>
                      <span className="ml-2 text-xs text-ink/50">
                        <code className="rounded bg-ink/5 px-1">{c.subProcessor.code}</code> ·{" "}
                        {c.subProcessor.jurisdiction}
                      </span>
                    </div>
                    <span className="text-xs text-ink/70">
                      effective {c.effectiveAt.toISOString().slice(0, 10)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{c.description}</p>
                  <div className="mt-1 text-xs text-ink/50">
                    Announced {c.announcedAt.toISOString().slice(0, 10)}.
                  </div>

                  {isOperator && objections.length > 0 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-ink/70">
                        {objections.length} objection{objections.length === 1 ? "" : "s"} raised
                      </summary>
                      <ul className="mt-1 space-y-1">
                        {objections.map((o) => (
                          <li key={o.id} className="rounded bg-ink/5 p-2">
                            <div className="text-xs text-ink/50">
                              tenant {o.tenantId} · raised {o.raisedAt.toISOString().slice(0, 10)}
                            </div>
                            <p className="whitespace-pre-wrap">{o.reason}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {isClient && ownObjection && !ownObjection.withdrawnAt && (
                    <div className="mt-2 rounded border border-amber-300 bg-amber-100/50 p-2 text-xs">
                      <strong>Your objection lodged {ownObjection.raisedAt.toISOString().slice(0, 10)}.</strong>
                      <p className="mt-1 whitespace-pre-wrap">{ownObjection.reason}</p>
                      <form action={withdrawObjectionAction} className="mt-2 grid gap-1">
                        <input type="hidden" name="objectionId" value={ownObjection.id} />
                        <input
                          className="input"
                          name="reason"
                          placeholder="Reason for withdrawal (optional)"
                          maxLength={500}
                        />
                        <button className="btn justify-self-start" type="submit">
                          Withdraw objection
                        </button>
                      </form>
                    </div>
                  )}

                  {isClient && canObject && (!ownObjection || ownObjection.withdrawnAt) && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-ink/70">Raise objection</summary>
                      <form action={raiseObjectionAction} className="mt-1 grid gap-1">
                        <input type="hidden" name="changeId" value={c.id} />
                        <textarea
                          className="input"
                          name="reason"
                          rows={3}
                          required
                          maxLength={2000}
                          placeholder="Why your firm objects to this change. The objection is recorded on your tenant's audit chain and visible to Acumon."
                        />
                        <button className="btn btn-primary justify-self-start" type="submit">
                          Lodge objection
                        </button>
                      </form>
                    </details>
                  )}

                  {isOperator && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-ink/70">Operator actions</summary>
                      <div className="mt-1 grid gap-2">
                        <form action={confirmChangeNowAction} className="grid gap-1">
                          <input type="hidden" name="changeId" value={c.id} />
                          <p className="text-xs text-ink/60">
                            Confirming now before the effective date overrides the notice
                            period. This is audited with <code>noticeOverride=true</code>.
                          </p>
                          <button className="btn justify-self-start" type="submit">
                            Confirm now
                          </button>
                        </form>
                        <form action={cancelChangeAction} className="grid gap-1">
                          <input type="hidden" name="changeId" value={c.id} />
                          <input
                            className="input"
                            name="reason"
                            required
                            placeholder="Reason for cancellation"
                            maxLength={500}
                          />
                          <button className="btn justify-self-start" type="submit">
                            Cancel change
                          </button>
                        </form>
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
                    <summary className="cursor-pointer text-ink/60">Edit / announce removal</summary>
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
                        Save (no notice)
                      </button>
                    </form>
                    <form action={announceExistingAction} className="mt-2 grid gap-1 text-sm">
                      <input type="hidden" name="code" value={s.code} />
                      <input type="hidden" name="kind" value="REMOVED" />
                      <textarea
                        className="input"
                        name="description"
                        rows={2}
                        required
                        placeholder="Why this sub-processor is being removed (visible to Clients)"
                      />
                      <input
                        className="input"
                        name="noticeDays"
                        type="number"
                        min={1}
                        max={365}
                        defaultValue={DEFAULT_NOTICE_DAYS}
                        placeholder="Notice days"
                      />
                      <button className="btn btn-primary justify-self-start" type="submit">
                        Announce removal (recommended)
                      </button>
                    </form>
                    <form action={announceExistingAction} className="mt-2 grid gap-1 text-sm">
                      <input type="hidden" name="code" value={s.code} />
                      <input type="hidden" name="kind" value="MATERIAL_UPDATE" />
                      <textarea
                        className="input"
                        name="description"
                        rows={2}
                        required
                        placeholder="Material change details (jurisdiction, scope, contract terms)"
                      />
                      <input
                        className="input"
                        name="noticeDays"
                        type="number"
                        min={1}
                        max={365}
                        defaultValue={DEFAULT_NOTICE_DAYS}
                        placeholder="Notice days"
                      />
                      <button className="btn justify-self-start" type="submit">
                        Announce material change
                      </button>
                    </form>
                    <form action={setActiveAction} className="mt-2 grid gap-1 text-sm">
                      <input type="hidden" name="code" value={s.code} />
                      <input type="hidden" name="active" value="false" />
                      <input
                        className="input"
                        name="notes"
                        placeholder="Reason for immediate removal (emergency only)"
                      />
                      <button className="btn justify-self-start" type="submit">
                        Mark removed (immediate, no notice)
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
            <summary className="cursor-pointer text-sm font-medium">Announce new sub-processor (recommended)</summary>
            <p className="mt-1 text-xs text-ink/60">
              Creates the sub-processor as inactive and fans out a DPA art. 28(2)(a) prior-notice
              notification to every Client&rsquo;s FIRM_ADMIN. Promotion to active happens
              automatically once the notice window elapses, or by clicking &ldquo;Confirm
              now&rdquo; on the pending change (audited as a notice override).
            </p>
            <form action={announceAddAction} className="mt-2 grid gap-2 text-sm">
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
              <textarea
                className="input"
                name="description"
                required
                rows={3}
                placeholder="Why this sub-processor is being added (visible to Clients in the notice)"
                maxLength={2000}
              />
              <input
                className="input"
                name="noticeDays"
                type="number"
                min={1}
                max={365}
                defaultValue={DEFAULT_NOTICE_DAYS}
                placeholder="Notice days"
              />
              <button className="btn btn-primary justify-self-start" type="submit">
                Announce addition
              </button>
            </form>
            <details className="mt-3 border-t border-ink/10 pt-2 text-xs">
              <summary className="cursor-pointer text-ink/60">
                Immediate add (emergency only — no notice given)
              </summary>
              <p className="mt-1 text-ink/60">
                Use only when contractual notice is genuinely impossible (security incident,
                bankruptcy of a sub-processor). The action is audited and Clients can object
                retroactively.
              </p>
              <form action={addAction} className="mt-2 grid gap-2">
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
                <input className="input" name="role" required placeholder="Role" maxLength={200} />
                <input className="input" name="jurisdiction" required placeholder="Jurisdiction" maxLength={64} />
                <input className="input" name="dataCategories" placeholder="Data categories (comma-separated)" />
                <input className="input" name="contractRef" placeholder="Contract reference (optional)" />
                <textarea className="input" name="notes" rows={2} placeholder="Notes (optional)" />
                <button className="btn justify-self-start" type="submit">
                  Add immediately
                </button>
              </form>
            </details>
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
