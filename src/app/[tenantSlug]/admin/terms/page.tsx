import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { activateTerms, getTermsView, recordTerms } from "@/lib/terms";
import type { TermsKind, TermsRecord, TermsStatus } from "@prisma/client";

const KIND_LABEL: Record<TermsKind, string> = {
  MSA: "Master Services Agreement",
  DPA: "Data Processing Agreement",
  AUP: "Acceptable Use Policy",
  SLA: "Service Level Agreement",
};

const STATUS_BADGE: Record<TermsStatus, string> = {
  DRAFT: "bg-sky-100 text-sky-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  SUPERSEDED: "bg-ink/10 text-ink/60",
};

const KINDS: TermsKind[] = ["MSA", "DPA", "AUP", "SLA"];

export default async function TermsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "terms:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getTermsView(ctx.tenant.id);
  const canManage = hasPermission(ctx.membership.role, "terms:manage");

  async function recordAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "terms:manage")) throw new Error("forbidden");

    function parseDate(v: FormDataEntryValue | null): Date | null {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    await recordTerms({
      tenantId: inner.tenant.id,
      kind: String(formData.get("kind") ?? "MSA") as TermsKind,
      documentRef: String(formData.get("documentRef") ?? ""),
      body: String(formData.get("body") ?? ""),
      effectiveFrom: parseDate(formData.get("effectiveFrom")),
      effectiveTo: parseDate(formData.get("effectiveTo")),
      signedByName: String(formData.get("signedByName") ?? "").trim() || null,
      signedByRole: String(formData.get("signedByRole") ?? "").trim() || null,
      signedAt: parseDate(formData.get("signedAt")),
      countersignedByName: String(formData.get("countersignedByName") ?? "").trim() || null,
      countersignedAt: parseDate(formData.get("countersignedAt")),
      notes: String(formData.get("notes") ?? "").trim() || null,
      activate: formData.get("activate") === "true",
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/terms`);
  }

  async function activateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "terms:manage")) throw new Error("forbidden");
    await activateTerms({
      tenantId: inner.tenant.id,
      recordId: String(formData.get("recordId") ?? ""),
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/terms`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Terms and Conditions</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §15.4 — your tenant&rsquo;s MSA, DPA, AUP, and SLA versioned and persisted.
          Records survive non-renewal and are retained per §12.5 for audit-log access and DSAR
          fulfilment. The Sub-Processor List is published separately as a global page under
          §15.3.
        </p>
      </div>

      {KINDS.map((kind) => (
        <KindSection
          key={kind}
          kind={kind}
          active={view.active[kind]}
          history={view.history[kind]}
          canManage={canManage}
          activateAction={activateAction}
        />
      ))}

      {canManage && (
        <section className="card space-y-3">
          <h2 className="text-base font-medium">Record a new version</h2>
          <p className="text-xs text-ink/60">
            Stage a new version of any of the four kinds. Tick &ldquo;activate&rdquo; to make it
            ACTIVE on creation — the previous ACTIVE version (if any) is automatically
            superseded.
          </p>
          <form action={recordAction} className="grid gap-2 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Kind</span>
                <select className="input" name="kind" defaultValue="MSA">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k} — {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Document reference</span>
                <input
                  className="input"
                  name="documentRef"
                  required
                  maxLength={1000}
                  placeholder="DocuSign envelope id, contract repo path, …"
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-xs text-ink/60">Body (full text or operative summary)</span>
              <textarea
                className="input font-mono"
                name="body"
                required
                rows={6}
                maxLength={200_000}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Effective from</span>
                <input className="input" name="effectiveFrom" type="date" />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-ink/60">Effective to (optional)</span>
                <input className="input" name="effectiveTo" type="date" />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input className="input" name="signedByName" placeholder="Signed by (name)" maxLength={200} />
              <input className="input" name="signedByRole" placeholder="Role" maxLength={200} />
              <input className="input" name="signedAt" type="date" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                name="countersignedByName"
                placeholder="Counter-signed by (Acumon)"
                maxLength={200}
              />
              <input className="input" name="countersignedAt" type="date" />
            </div>
            <textarea className="input" name="notes" rows={2} placeholder="Notes (optional)" maxLength={4000} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="activate" value="true" /> Activate immediately
              (supersedes the previous ACTIVE version)
            </label>
            <button className="btn btn-primary justify-self-start" type="submit">
              Record version
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function KindSection({
  kind,
  active,
  history,
  canManage,
  activateAction,
}: {
  kind: TermsKind;
  active: TermsRecord | null;
  history: TermsRecord[];
  canManage: boolean;
  activateAction: (formData: FormData) => Promise<void>;
}) {
  const drafts = history.filter((h) => h.status === "DRAFT");
  const superseded = history.filter((h) => h.status === "SUPERSEDED");
  return (
    <section className="card space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">{KIND_LABEL[kind]}</h2>
        <span className="text-xs text-ink/50">{kind}</span>
      </div>
      {active ? (
        <RecordRow record={active} />
      ) : (
        <p className="text-sm text-ink/60">No active version recorded.</p>
      )}

      {drafts.length > 0 && (
        <div className="space-y-2 border-t border-ink/10 pt-3">
          <h3 className="text-sm font-medium">Drafts ({drafts.length})</h3>
          {drafts.map((d) => (
            <div key={d.id} className="flex items-baseline justify-between gap-2">
              <RecordRow record={d} compact />
              {canManage && (
                <form action={activateAction} className="shrink-0">
                  <input type="hidden" name="recordId" value={d.id} />
                  <button className="btn btn-primary" type="submit">
                    Activate v{d.version}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}

      {superseded.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink/60">
            Superseded history ({superseded.length})
          </summary>
          <div className="mt-2 space-y-2">
            {superseded.map((s) => (
              <RecordRow key={s.id} record={s} compact />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function RecordRow({ record, compact = false }: { record: TermsRecord; compact?: boolean }) {
  return (
    <div className="rounded border border-ink/10 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className={`tag mr-2 ${STATUS_BADGE[record.status]}`}>
            {record.status.toLowerCase()}
          </span>
          <span className="font-medium">v{record.version}</span>
          {record.documentRef && (
            <span className="ml-2 text-xs text-ink/50">
              <code className="rounded bg-ink/5 px-1">{record.documentRef}</code>
            </span>
          )}
        </div>
        <span className="text-xs text-ink/50">
          {record.effectiveFrom && (
            <>from {record.effectiveFrom.toISOString().slice(0, 10)}</>
          )}
          {record.effectiveTo && <> · to {record.effectiveTo.toISOString().slice(0, 10)}</>}
        </span>
      </div>
      {!compact && record.body && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink/60">Body</summary>
          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-ink/5 p-2 text-xs">
            {record.body}
          </pre>
        </details>
      )}
      {(record.signedByName || record.countersignedByName) && (
        <p className="mt-1 text-xs text-ink/60">
          {record.signedByName && (
            <>
              Signed by <strong>{record.signedByName}</strong>
              {record.signedByRole && <> ({record.signedByRole})</>}
              {record.signedAt && <> on {record.signedAt.toISOString().slice(0, 10)}</>}
            </>
          )}
          {record.countersignedByName && (
            <>
              {record.signedByName && " · "}
              Counter-signed by <strong>{record.countersignedByName}</strong>
              {record.countersignedAt && <> on {record.countersignedAt.toISOString().slice(0, 10)}</>}
            </>
          )}
        </p>
      )}
      {record.notes && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-ink/60">{record.notes}</p>
      )}
    </div>
  );
}
