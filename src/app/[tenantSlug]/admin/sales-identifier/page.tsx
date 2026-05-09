import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { getDpiaStatus } from "@/lib/dpia/status";
import {
  setSalesIdentifierEnabled,
  attestSalesIdentifierLawfulBasis,
} from "@/lib/opportunities/admin";

export default async function SalesIdentifierAdminPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "members:write")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const [tenant, dpia, recent] = await Promise.all([
    superDb.tenant.findUnique({
      where: { id: ctx.tenant.id },
      select: {
        salesIdentifierEnabled: true,
        salesIdentifierEnabledAt: true,
        salesIdentifierLawfulBasisAttestedAt: true,
        salesIdentifierLawfulBasisAttestedBy: true,
        salesIdentifierLawfulBasisNote: true,
      },
    }),
    getDpiaStatus(ctx.tenant.id),
    superDb.opportunityCandidate.count({ where: { tenantId: ctx.tenant.id } }),
  ]);
  if (!tenant) redirect(`/${tenantSlug}/dashboard`);

  const lawfulBasisOnFile = !!tenant.salesIdentifierLawfulBasisAttestedAt;
  const dpiaOk = dpia.salesIdentifierAllowed;
  const fullyOperational = tenant.salesIdentifierEnabled && lawfulBasisOnFile && dpiaOk;

  async function toggleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "members:write")) throw new Error("forbidden");
    const enabled = formData.get("enabled") === "true";
    await setSalesIdentifierEnabled({
      tenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      enabled,
    });
    revalidatePath(`/${tenantSlug}/admin/sales-identifier`);
    revalidatePath(`/${tenantSlug}/dpia`);
    revalidatePath(`/${tenantSlug}/opportunities`);
  }

  async function attestAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "members:write")) throw new Error("forbidden");
    await attestSalesIdentifierLawfulBasis({
      tenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      signedByName: String(formData.get("signedByName") ?? "").trim(),
      signedByRole: String(formData.get("signedByRole") ?? "").trim(),
      note: (formData.get("note") as string | null) ?? null,
    });
    revalidatePath(`/${tenantSlug}/admin/sales-identifier`);
    revalidatePath(`/${tenantSlug}/opportunities`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales Identifier</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §8 — opt-in revenue-opportunity add-on. Mining counterparty correspondence to identify
          opportunities is a separate processing purpose under PRD §8.5; the lawful-basis
          attestation below is an additional acknowledgement on top of the main DPIA.
        </p>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">Status</h2>
          <span
            className={`tag ${
              fullyOperational
                ? "bg-emerald-100 text-emerald-800"
                : tenant.salesIdentifierEnabled
                  ? "bg-amber-100 text-amber-800"
                  : "bg-ink/10 text-ink/60"
            }`}
          >
            {fullyOperational
              ? "active"
              : tenant.salesIdentifierEnabled
                ? "enabled — gated"
                : "disabled"}
          </span>
        </div>

        <ul className="space-y-1 text-sm">
          <Gate
            ok={tenant.salesIdentifierEnabled}
            label="Add-on enabled by Firm Administrator"
            detail={
              tenant.salesIdentifierEnabledAt
                ? `since ${tenant.salesIdentifierEnabledAt.toISOString().slice(0, 10)}`
                : "not enabled"
            }
          />
          <Gate
            ok={lawfulBasisOnFile}
            label="Separate lawful-basis acknowledgement on file (PRD §8.5)"
            detail={
              lawfulBasisOnFile
                ? `attested ${tenant.salesIdentifierLawfulBasisAttestedAt!
                    .toISOString()
                    .slice(0, 10)} by ${tenant.salesIdentifierLawfulBasisAttestedBy ?? ""}`
                : "missing — detector will refuse to run"
            }
          />
          <Gate
            ok={dpiaOk}
            label="DPIA permits Sales Identifier"
            detail={`current DPIA state: ${dpia.state}`}
          />
        </ul>

        <p className="text-xs text-ink/60">
          {recent} candidate{recent === 1 ? "" : "s"} on file. The detector runs on inbound
          ingestion (Phase 3) and via the manual scan button in the reviewer console. Disabling
          here does not delete existing candidates.
        </p>
      </div>

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Enable / disable add-on</h2>
        <p className="text-xs text-ink/60">
          Toggling the add-on on changes the DPIA scope hash and triggers a re-attestation
          requirement on the DPIA Helper page (PRD §12.2).
        </p>
        <form action={toggleAction} className="flex items-center gap-3">
          <input
            type="hidden"
            name="enabled"
            value={(!tenant.salesIdentifierEnabled).toString()}
          />
          <button type="submit" className="btn btn-primary text-sm">
            {tenant.salesIdentifierEnabled ? "Disable" : "Enable"} Sales Identifier
          </button>
          {!dpiaOk && tenant.salesIdentifierEnabled === false && (
            <span className="text-xs text-amber-700">
              DPIA gate currently fails — enabling will not produce candidates until the DPIA is
              re-attested.
            </span>
          )}
        </form>
      </div>

      <form action={attestAction} className="card space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Lawful-basis acknowledgement</h2>
          {lawfulBasisOnFile && (
            <span className="tag bg-emerald-100 text-emerald-800 text-xs">on file</span>
          )}
        </div>
        <p className="text-sm text-ink/70">
          Per PRD §8.5, mining client correspondence to identify revenue opportunities is a
          separate processing purpose from the core admin-reduction features. Where existing
          counterparty terms did not contemplate this use, the Client must update its privacy
          notice and (where relevant) obtain incremental consent.
        </p>

        {lawfulBasisOnFile && (
          <div className="rounded border border-ink/10 bg-ink/5 p-2 text-xs text-ink/70">
            Last attested:{" "}
            <strong>
              {tenant.salesIdentifierLawfulBasisAttestedAt!.toISOString().slice(0, 10)}
            </strong>{" "}
            · {tenant.salesIdentifierLawfulBasisAttestedBy}
            {tenant.salesIdentifierLawfulBasisNote && (
              <div className="mt-1 text-ink/60">{tenant.salesIdentifierLawfulBasisNote}</div>
            )}
            <div className="mt-1 text-ink/50">
              Re-attest below if the privacy notice changes or a new counterparty cohort comes into
              scope.
            </div>
          </div>
        )}

        <fieldset className="space-y-1 text-sm">
          <Ack
            name="privacyNoticeUpdated"
            label="Counterparty privacy notice has been reviewed and updated where required."
          />
          <Ack
            name="incrementalConsentObtained"
            label="Incremental consent obtained where existing terms did not cover this purpose."
          />
          <Ack
            name="reviewerCohortAuthorised"
            label="Sales Reviewer cohort is appointed and trained on the FCG routing rules."
          />
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Signed by — name</label>
            <input
              className="input"
              name="signedByName"
              required
              defaultValue={ctx.user.name ?? ctx.user.email}
              maxLength={120}
            />
          </div>
          <div>
            <label className="label">Signed by — role</label>
            <input
              className="input"
              name="signedByRole"
              required
              defaultValue="Firm Administrator"
              maxLength={120}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes (optional)</label>
            <textarea
              name="note"
              rows={3}
              className="input"
              maxLength={2000}
              placeholder="Privacy notice version, counterparty cohort scope, etc."
            />
          </div>
        </div>

        <button type="submit" className="btn btn-primary text-sm">
          {lawfulBasisOnFile ? "Re-attest lawful basis" : "Attest lawful basis"}
        </button>
      </form>
    </div>
  );
}

function Gate({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          ok ? "bg-emerald-500" : "bg-amber-500"
        }`}
        aria-hidden
      />
      <span>{label}</span>
      <span className="text-xs text-ink/50">— {detail}</span>
    </li>
  );
}

function Ack({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} required className="mt-1" />
      <span>{label}</span>
    </label>
  );
}
