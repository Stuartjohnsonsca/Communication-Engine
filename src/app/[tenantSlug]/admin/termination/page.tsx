import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  generateExportPackage,
  getTerminationView,
  noticeTermination,
  reverseTermination,
  type TerminationView,
} from "@/lib/termination";

export default async function TerminationPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "termination:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getTerminationView(ctx.tenant.id);
  const canManage = hasPermission(ctx.membership.role, "termination:manage");

  async function noticeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "termination:manage")) throw new Error("forbidden");
    await noticeTermination({
      tenantId: inner.tenant.id,
      byName: String(formData.get("byName") ?? ""),
      reason: String(formData.get("reason") ?? "").trim() || null,
      windowDays: Number(formData.get("windowDays") ?? 90),
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/termination`);
  }

  async function reverseAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "termination:manage")) throw new Error("forbidden");
    await reverseTermination({
      tenantId: inner.tenant.id,
      byName: String(formData.get("byName") ?? ""),
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/termination`);
  }

  async function exportAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "termination:manage")) throw new Error("forbidden");
    await generateExportPackage({
      tenantId: inner.tenant.id,
      generatedByMembershipId: inner.membership.id,
      generatedByName: inner.user.name ?? inner.user.email,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/termination`);
  }

  const t = view.tenant;
  const isTerminating = t.terminationNoticeAt != null && t.terminationCompletedAt == null;
  const isTerminated = t.terminationCompletedAt != null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenant termination</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §14.4 — record termination notice, pull the full export package, and let the
          90-day wind-down + hard-delete sweep run. Audit logs and DPIA attestations are
          retained per §12.5 even after deletion.
        </p>
      </div>

      <StatusCard tenant={t} />

      {!isTerminating && !isTerminated && canManage && (
        <NoticeCard action={noticeAction} />
      )}
      {isTerminating && canManage && (
        <ReverseCard action={reverseAction} />
      )}

      {!isTerminated && (
        <ExportCard
          exports={view.exports}
          tenantSlug={ctx.tenant.slug}
          canManage={canManage}
          action={exportAction}
        />
      )}
    </div>
  );
}

function StatusCard({ tenant: t }: { tenant: TerminationView["tenant"] }) {
  if (t.terminationCompletedAt) {
    return (
      <div className="card border-red-200 bg-red-50/40">
        <h2 className="text-base font-medium text-red-800">Hard-deleted</h2>
        <p className="mt-1 text-sm text-ink/80">
          The wind-down completed on {t.terminationCompletedAt.toISOString().slice(0, 10)}. The
          deletable data has been removed; audit chain and DPIA attestations are retained until{" "}
          {t.terminationStatutoryRetentionUntil?.toISOString().slice(0, 10) ?? "the statutory floor"}.
        </p>
      </div>
    );
  }
  if (t.terminationNoticeAt) {
    const remaining = t.terminationEffectiveAt
      ? Math.max(
          0,
          Math.ceil((t.terminationEffectiveAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        )
      : null;
    return (
      <div className="card border-amber-300 bg-amber-50/40">
        <h2 className="text-base font-medium text-amber-900">
          Termination noticed — {remaining != null ? `${remaining} day${remaining === 1 ? "" : "s"} until hard-delete` : "wind-down active"}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-xs text-ink/60">Notice received</dt>
            <dd>{t.terminationNoticeAt.toISOString().slice(0, 16).replace("T", " ")}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink/60">Effective at</dt>
            <dd>
              {t.terminationEffectiveAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink/60">Signed by</dt>
            <dd>{t.terminationByName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink/60">Status</dt>
            <dd>{t.status}</dd>
          </div>
        </dl>
        {t.terminationReason && (
          <p className="mt-2 whitespace-pre-wrap rounded bg-ink/5 p-2 text-sm">
            {t.terminationReason}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <h2 className="text-base font-medium">Active</h2>
      <p className="mt-1 text-sm text-ink/70">
        No termination noticed. You can pull an export package at any time during the contract
        per PRD §15.3.
      </p>
    </div>
  );
}

function NoticeCard({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="card space-y-3">
      <h2 className="text-base font-medium">Notice termination</h2>
      <p className="text-xs text-ink/60">
        This moves the tenant to the wind-down state. Your users can still sign in; production
        services keep running until hard-deletion. You can withdraw the notice any time before
        the cut-off.
      </p>
      <form action={action} className="grid gap-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-xs text-ink/60">Signed by (name + role)</span>
            <input className="input" name="byName" required maxLength={200} placeholder="Jane Smith, COO" />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-ink/60">Window (days, default 90)</span>
            <input
              className="input"
              name="windowDays"
              type="number"
              defaultValue={90}
              min={1}
              max={365}
            />
          </label>
        </div>
        <textarea
          className="input"
          name="reason"
          rows={3}
          maxLength={4000}
          placeholder="Reason (optional — appears in the audit trail and on the wind-down page)"
        />
        <button className="btn justify-self-start" type="submit">
          Record termination notice
        </button>
      </form>
    </section>
  );
}

function ReverseCard({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="card space-y-3 border-emerald-300">
      <h2 className="text-base font-medium">Withdraw termination notice</h2>
      <p className="text-xs text-ink/60">
        Returns the tenant to ACTIVE. Already-generated export packages remain on file.
      </p>
      <form action={action} className="grid gap-2 text-sm">
        <label className="grid gap-1">
          <span className="text-xs text-ink/60">Signed by (name + role)</span>
          <input className="input" name="byName" required maxLength={200} />
        </label>
        <textarea className="input" name="notes" rows={2} maxLength={4000} placeholder="Notes (optional)" />
        <button className="btn btn-primary justify-self-start" type="submit">
          Withdraw notice
        </button>
      </form>
    </section>
  );
}

function ExportCard({
  exports,
  tenantSlug,
  canManage,
  action,
}: {
  exports: TerminationView["exports"];
  tenantSlug: string;
  canManage: boolean;
  action: () => Promise<void>;
}) {
  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">Export packages</h2>
        {canManage && (
          <form action={action}>
            <button className="btn btn-primary" type="submit">
              Generate new package
            </button>
          </form>
        )}
      </div>
      <p className="text-xs text-ink/60">
        JSON snapshot of FCG versions, UCGs, drafts, meeting records, audit chain, DPIA
        attestations, DSAR records, billing periods, and sign-off questions. Per PRD §15.3
        this is no-charge and on-demand throughout the contract.
      </p>
      {exports.length === 0 ? (
        <p className="text-sm text-ink/60">No packages generated yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {exports.map((e) => {
            const counts = (e.counts as Record<string, number>) ?? {};
            const total = Object.values(counts).reduce((s, n) => s + (typeof n === "number" ? n : 0), 0);
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/5 py-1 last:border-0"
              >
                <span>
                  <span className="text-ink/80">
                    {e.generatedAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  {e.generatedByName && (
                    <span className="ml-2 text-xs text-ink/50">by {e.generatedByName}</span>
                  )}
                </span>
                <span className="flex items-center gap-2 text-xs text-ink/50">
                  <span>{Math.round(e.bytes / 1024)} KB</span>
                  <span>· {total} items</span>
                  <a
                    className="underline decoration-dotted"
                    href={`/api/termination/export/${e.id}?tenantSlug=${encodeURIComponent(tenantSlug)}`}
                  >
                    Download
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
