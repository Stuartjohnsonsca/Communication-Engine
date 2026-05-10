import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  APPLICABILITY_OPTIONS,
  addProcessingActivity,
  getProcessingMap,
  isAcumonComplianceOperator,
  updateProcessingActivity,
} from "@/lib/compliance/processing-map";

export default async function ProcessingMapPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "processing-map:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const map = await getProcessingMap(ctx.tenant);
  const isOperator =
    isAcumonComplianceOperator(ctx.tenant.slug) &&
    hasPermission(ctx.membership.role, "processing-map:manage");

  async function addAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonComplianceOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "processing-map:manage")
    ) {
      throw new Error("forbidden");
    }
    await addProcessingActivity({
      code: String(formData.get("code") ?? ""),
      label: String(formData.get("label") ?? ""),
      controller: String(formData.get("controller") ?? ""),
      processor: String(formData.get("processor") ?? ""),
      lawfulBasis: String(formData.get("lawfulBasis") ?? "").trim() || null,
      contract: String(formData.get("contract") ?? "").trim() || null,
      processesPersonal: formData.get("processesPersonal") === "on",
      processesSpecial: formData.get("processesSpecial") === "on",
      applicabilityFlag: String(formData.get("applicabilityFlag") ?? "always") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/processing-map`);
  }

  async function updateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonComplianceOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "processing-map:manage")
    ) {
      throw new Error("forbidden");
    }
    await updateProcessingActivity({
      code: String(formData.get("code") ?? ""),
      label: String(formData.get("label") ?? "") || undefined,
      controller: String(formData.get("controller") ?? "") || undefined,
      processor: String(formData.get("processor") ?? "") || undefined,
      lawfulBasis: String(formData.get("lawfulBasis") ?? "").trim() || null,
      contract: String(formData.get("contract") ?? "").trim() || null,
      processesPersonal: formData.get("processesPersonal") === "on",
      processesSpecial: formData.get("processesSpecial") === "on",
      applicabilityFlag: String(formData.get("applicabilityFlag") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/processing-map`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Controller / Processor map
        </h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §12.1 — every processing activity in the platform with the controller / processor
          designation, the lawful basis, and the governing contract. The matrix is product-wide
          and identical for every Client; the &ldquo;applies to this tenant&rdquo; column reflects{" "}
          <strong>{ctx.tenant.name}</strong>&rsquo;s feature footprint.
        </p>
      </div>

      <section className="card grid gap-3 md:grid-cols-2">
        <div className="rounded bg-emerald-50 p-3 text-sm">
          <div className="text-xs text-ink/60">Active for this tenant</div>
          <div className="text-2xl font-semibold text-emerald-900">{map.activeCount}</div>
        </div>
        <div className="rounded bg-ink/5 p-3 text-sm">
          <div className="text-xs text-ink/60">Not currently engaged</div>
          <div className="text-2xl font-semibold text-ink/70">{map.notApplicableCount}</div>
        </div>
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink/10 text-left text-xs uppercase tracking-wide text-ink/60">
            <tr>
              <th className="py-2 pr-3">Processing</th>
              <th className="py-2 pr-3">Controller</th>
              <th className="py-2 pr-3">Processor</th>
              <th className="py-2 pr-3">Contract</th>
              <th className="py-2 pr-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {map.rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-ink/5 align-top last:border-0 ${
                  row.applies ? "" : "opacity-60"
                }`}
              >
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.label}</div>
                  <div className="text-xs text-ink/50">
                    <code className="rounded bg-ink/5 px-1">{row.code}</code>
                  </div>
                  {row.processesSpecial && (
                    <div className="mt-1 text-[11px] text-amber-700">
                      ⚠ Special-category data
                    </div>
                  )}
                  {row.notes && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-ink/60">{row.notes}</p>
                  )}
                </td>
                <td className="py-2 pr-3">{row.controller}</td>
                <td className="py-2 pr-3">{row.processor}</td>
                <td className="py-2 pr-3">
                  {row.contract ?? <span className="text-ink/40">—</span>}
                  {row.lawfulBasis && (
                    <div className="mt-1 text-xs text-ink/50">{row.lawfulBasis}</div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {row.applies ? (
                    <span className="tag bg-emerald-100 text-xs text-emerald-900">Active</span>
                  ) : (
                    <span className="tag bg-ink/5 text-xs text-ink/60">Not engaged</span>
                  )}
                  <div className="mt-1 text-[11px] text-ink/50">{row.applicabilityReason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Where each row is wired in this product</h2>
        <ul className="grid gap-1 pl-5 text-sm md:grid-cols-2">
          <li className="list-disc">
            Sub-processors per row →{" "}
            <Link
              href={`/${tenantSlug}/switching`}
              className="underline decoration-dotted"
            >
              switching posture
            </Link>
          </li>
          <li className="list-disc">
            DPIA scope + attestation →{" "}
            <Link href={`/${tenantSlug}/dpia`} className="underline decoration-dotted">
              DPIA workspace
            </Link>
          </li>
          <li className="list-disc">
            Cross-Client Learning opt-in →{" "}
            <Link
              href={`/${tenantSlug}/admin/xcl`}
              className="underline decoration-dotted"
            >
              XCL controls
            </Link>
          </li>
          <li className="list-disc">
            Sales Identifier lawful basis →{" "}
            <Link
              href={`/${tenantSlug}/admin/sales-identifier`}
              className="underline decoration-dotted"
            >
              Sales Identifier admin
            </Link>
          </li>
          <li className="list-disc">
            Authorised channels → {" "}
            <Link
              href={`/${tenantSlug}/admin/channels`}
              className="underline decoration-dotted"
            >
              channels
            </Link>
          </li>
          <li className="list-disc">
            Terms governing each contract column →{" "}
            <Link
              href={`/${tenantSlug}/admin/terms`}
              className="underline decoration-dotted"
            >
              terms admin
            </Link>
          </li>
        </ul>
      </section>

      {isOperator && (
        <>
          <section className="card space-y-3 border-amber-300 bg-amber-50/40">
            <h2 className="text-base font-medium">Operator: edit rows</h2>
            <p className="text-xs text-ink/60">
              Mutating the controller / processor map is an Acumon-product decision, not a
              per-Client one. Audit events land on the operator&rsquo;s tenant chain.
            </p>
            <div className="space-y-3">
              {map.rows.map((row) => (
                <details key={row.id} className="rounded border border-ink/10 p-3">
                  <summary className="cursor-pointer text-sm">
                    Edit <code className="rounded bg-ink/5 px-1 text-xs">{row.code}</code> ·{" "}
                    {row.label}
                  </summary>
                  <form action={updateAction} className="mt-3 grid gap-2 text-sm">
                    <input type="hidden" name="code" value={row.code} />
                    <input
                      className="input"
                      name="label"
                      defaultValue={row.label}
                      required
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className="input"
                        name="controller"
                        defaultValue={row.controller}
                        required
                        placeholder="Controller"
                      />
                      <input
                        className="input"
                        name="processor"
                        defaultValue={row.processor}
                        required
                        placeholder="Processor"
                      />
                    </div>
                    <input
                      className="input"
                      name="lawfulBasis"
                      defaultValue={row.lawfulBasis ?? ""}
                      placeholder="Lawful basis"
                    />
                    <input
                      className="input"
                      name="contract"
                      defaultValue={row.contract ?? ""}
                      placeholder="Contract / addendum"
                    />
                    <select
                      className="input"
                      name="applicabilityFlag"
                      defaultValue={row.applicabilityFlag ?? "always"}
                    >
                      {APPLICABILITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-4 text-xs">
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          name="processesPersonal"
                          defaultChecked={row.processesPersonal}
                        />
                        Processes personal data
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          name="processesSpecial"
                          defaultChecked={row.processesSpecial}
                        />
                        Special-category data
                      </label>
                    </div>
                    <textarea
                      className="input"
                      name="notes"
                      rows={2}
                      defaultValue={row.notes ?? ""}
                      placeholder="Notes"
                    />
                    <button className="btn justify-self-start" type="submit">
                      Save
                    </button>
                  </form>
                </details>
              ))}
            </div>
          </section>

          <section className="card space-y-3 border-amber-300 bg-amber-50/40">
            <details>
              <summary className="cursor-pointer text-sm font-medium">Add row</summary>
              <form action={addAction} className="mt-3 grid gap-2 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="input"
                    name="code"
                    required
                    placeholder="stable-code"
                    pattern="[a-z0-9_-]+"
                    maxLength={64}
                  />
                  <select className="input" name="applicabilityFlag" defaultValue="always">
                    {APPLICABILITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  className="input"
                  name="label"
                  required
                  placeholder="Activity label"
                  maxLength={200}
                />
                <div className="grid grid-cols-2 gap-2">
                  <input className="input" name="controller" required placeholder="Controller" />
                  <input className="input" name="processor" required placeholder="Processor" />
                </div>
                <input className="input" name="lawfulBasis" placeholder="Lawful basis" />
                <input className="input" name="contract" placeholder="Contract / addendum" />
                <div className="flex flex-wrap gap-4 text-xs">
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="processesPersonal" defaultChecked />
                    Processes personal data
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" name="processesSpecial" />
                    Special-category data
                  </label>
                </div>
                <textarea className="input" name="notes" rows={2} placeholder="Notes" />
                <button className="btn btn-primary justify-self-start" type="submit">
                  Add row
                </button>
              </form>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
