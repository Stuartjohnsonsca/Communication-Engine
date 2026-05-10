import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  TIA_STATE_LABELS,
  getCrossBorderView,
  recordTia,
  revokeTia,
} from "@/lib/compliance/cross-border";

export default async function TransfersPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "transfers:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getCrossBorderView(ctx.tenant);
  const canManage = hasPermission(ctx.membership.role, "transfers:manage");

  async function recordAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "transfers:manage")) throw new Error("forbidden");
    const effectiveFromRaw = String(formData.get("effectiveFrom") ?? "");
    const effectiveToRaw = String(formData.get("effectiveTo") ?? "");
    await recordTia({
      tenantId: inner.tenant.id,
      subProcessorCode: String(formData.get("subProcessorCode") ?? ""),
      sccDocumentRef: String(formData.get("sccDocumentRef") ?? ""),
      tiaDocumentRef: String(formData.get("tiaDocumentRef") ?? ""),
      signedByName: String(formData.get("signedByName") ?? ""),
      signedByRole: String(formData.get("signedByRole") ?? ""),
      effectiveFrom: effectiveFromRaw ? new Date(effectiveFromRaw) : undefined,
      effectiveTo: effectiveToRaw ? new Date(effectiveToRaw) : undefined,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/transfers`);
  }

  async function revokeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "transfers:manage")) throw new Error("forbidden");
    await revokeTia({
      tenantId: inner.tenant.id,
      tiaId: String(formData.get("tiaId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/transfers`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cross-Border Transfer</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §12.6 — all your tenant data resides in{" "}
          <strong>{view.tenantJurisdiction}</strong>. Inference uses an in-region endpoint with
          contractual no-training and no-retention commitments. Third-country sub-processors
          require Standard Contractual Clauses + a documented Transfer Impact Assessment before
          any processing dependent on them is activated.
        </p>
      </div>

      <section className="card grid gap-3 md:grid-cols-3">
        <Stat label="Sub-processors" value={view.rows.length} />
        <Stat label="Third-country" value={view.thirdCountryCount} tone={view.uncovered.length > 0 ? "alert" : "ok"} />
        <Stat label="Uncovered" value={view.uncovered.length} tone={view.uncovered.length > 0 ? "alert" : "ok"} />
      </section>

      {view.uncovered.length > 0 && (
        <section className="card border-red-300 bg-red-50/50">
          <h2 className="text-base font-medium text-red-900">
            {view.uncovered.length} third-country sub-processor
            {view.uncovered.length === 1 ? "" : "s"} without a current TIA
          </h2>
          <p className="mt-1 text-sm text-red-900/80">
            Per §12.6 the platform blocks any activation that depends on these processors until
            SCCs and a TIA are recorded. Surfaces wired to{" "}
            <code className="rounded bg-white/60 px-1">transferGateOk()</code> will refuse
            until coverage is in place.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {view.uncovered.map((s) => (
              <li key={s.code}>
                <strong>{s.name}</strong>{" "}
                <span className="text-xs text-ink/60">({s.jurisdiction})</span> —{" "}
                {TIA_STATE_LABELS[s.tiaState]}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.expiringSoon.length > 0 && (
        <section className="card border-amber-300 bg-amber-50/40">
          <h2 className="text-base font-medium text-amber-900">
            {view.expiringSoon.length} TIA{view.expiringSoon.length === 1 ? "" : "s"} expiring
            within 30 days
          </h2>
          <p className="mt-1 text-sm text-amber-900/80">
            Renew before the expiry date or processing dependent on the sub-processor will be
            blocked.
          </p>
        </section>
      )}

      <section className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink/10 text-left text-xs uppercase tracking-wide text-ink/60">
            <tr>
              <th className="py-2 pr-3">Sub-processor</th>
              <th className="py-2 pr-3">Jurisdiction</th>
              <th className="py-2 pr-3">State</th>
              <th className="py-2 pr-3">Coverage</th>
              {canManage && <th className="py-2 pr-3"></th>}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((s) => (
              <tr key={s.id} className="border-b border-ink/5 align-top last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-ink/50">{s.role}</div>
                </td>
                <td className="py-2 pr-3 text-sm">{s.jurisdiction}</td>
                <td className="py-2 pr-3 text-xs">
                  <span
                    className={`tag ${
                      s.tiaState === "in-region"
                        ? "bg-emerald-100 text-emerald-900"
                        : s.tiaState === "covered"
                          ? "bg-emerald-100 text-emerald-900"
                          : s.tiaState === "expiring-soon"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-red-100 text-red-900"
                    }`}
                  >
                    {TIA_STATE_LABELS[s.tiaState]}
                  </span>
                </td>
                <td className="py-2 pr-3 text-xs text-ink/60">
                  {s.tia ? (
                    <>
                      <div>
                        SCC: <code className="rounded bg-ink/5 px-1">{s.tia.sccDocumentRef}</code>
                      </div>
                      <div>
                        TIA: <code className="rounded bg-ink/5 px-1">{s.tia.tiaDocumentRef}</code>
                      </div>
                      <div>
                        {s.tia.effectiveFrom.toISOString().slice(0, 10)} →{" "}
                        {s.tia.effectiveTo.toISOString().slice(0, 10)}
                      </div>
                      <div>
                        Signed by {s.tia.signedByName} ({s.tia.signedByRole})
                      </div>
                    </>
                  ) : s.thirdCountry ? (
                    <span className="text-red-700">No TIA on file.</span>
                  ) : (
                    <span className="text-ink/50">In-region — TIA not required.</span>
                  )}
                </td>
                {canManage && (
                  <td className="py-2 pr-3 text-xs">
                    {s.thirdCountry && (
                      <details>
                        <summary className="cursor-pointer text-ink/60">
                          {s.tia && s.tia.status === "RECORDED" ? "Renew / revoke" : "Record TIA"}
                        </summary>
                        <form action={recordAction} className="mt-2 grid gap-1 text-sm">
                          <input
                            type="hidden"
                            name="subProcessorCode"
                            value={s.code}
                          />
                          <input
                            className="input"
                            name="sccDocumentRef"
                            required
                            placeholder="SCC document reference"
                            defaultValue={s.tia?.sccDocumentRef ?? ""}
                          />
                          <input
                            className="input"
                            name="tiaDocumentRef"
                            required
                            placeholder="TIA document reference"
                            defaultValue={s.tia?.tiaDocumentRef ?? ""}
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              className="input"
                              name="signedByName"
                              required
                              placeholder="Signed by (name)"
                              defaultValue={s.tia?.signedByName ?? ""}
                            />
                            <input
                              className="input"
                              name="signedByRole"
                              required
                              placeholder="Role"
                              defaultValue={s.tia?.signedByRole ?? "Data Protection Officer"}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              className="input"
                              name="effectiveFrom"
                              type="date"
                              defaultValue={s.tia?.effectiveFrom.toISOString().slice(0, 10)}
                            />
                            <input
                              className="input"
                              name="effectiveTo"
                              type="date"
                              defaultValue={s.tia?.effectiveTo.toISOString().slice(0, 10)}
                            />
                          </div>
                          <textarea
                            className="input"
                            name="notes"
                            rows={2}
                            placeholder="Notes (optional)"
                          />
                          <button className="btn justify-self-start" type="submit">
                            Save TIA
                          </button>
                        </form>
                        {s.tia && s.tia.status === "RECORDED" && (
                          <form action={revokeAction} className="mt-2 grid gap-1 text-sm">
                            <input type="hidden" name="tiaId" value={s.tia.id} />
                            <input
                              className="input"
                              name="reason"
                              required
                              placeholder="Revoke reason (e.g. closed dependent channel)"
                            />
                            <button className="btn justify-self-start" type="submit">
                              Revoke TIA
                            </button>
                          </form>
                        )}
                      </details>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">How this gate behaves</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            UK + EU jurisdictions are treated as in-region. The catalogue lives at{" "}
            <Link
              href={`/${tenantSlug}/switching`}
              className="underline decoration-dotted"
            >
              switching posture
            </Link>
            .
          </li>
          <li>
            Third-country jurisdictions block downstream activation via{" "}
            <code className="rounded bg-ink/5 px-1">transferGateOk()</code> in{" "}
            <code className="rounded bg-ink/5 px-1">src/lib/compliance/cross-border.ts</code>.
          </li>
          <li>
            TIAs default to a 12-month window and auto-flip to{" "}
            <strong>EXPIRED</strong> by the lifecycle-sweep cron when the date passes.
          </li>
          <li>
            Audit events <code>TIA_RECORDED</code> / <code>TIA_REVOKED</code> /{" "}
            <code>TIA_EXPIRED</code> land on this tenant&rsquo;s chain.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "alert";
}) {
  return (
    <div
      className={`rounded p-3 text-center ${
        tone === "alert" ? "bg-red-50" : "bg-emerald-50"
      }`}
    >
      <div className="text-xs text-ink/60">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
