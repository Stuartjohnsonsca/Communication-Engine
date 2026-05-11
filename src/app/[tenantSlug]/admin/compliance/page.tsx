import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { ALL_SECTIONS } from "@/lib/compliance/evidence-pack";
import { DownloadEvidencePackButton } from "./DownloadEvidencePackButton";

/**
 * Compliance evidence pack (post-PRD hardening).
 *
 * One-click downloadable JSON snapshot of the tenant's security +
 * compliance posture, composed from the existing modules. Procurement
 * reviewers ask the same questions every audit cycle ("show us your
 * security configuration", "show us your sub-processors", "show us
 * your audit chain integrity") — this page answers them all from a
 * single download.
 *
 * Every export writes a `COMPLIANCE_EVIDENCE_PACK_EXPORTED` audit row
 * with the actor + section list so the chain itself records who pulled
 * which slice when. Generation is on demand, never cached.
 */
export const dynamic = "force-dynamic";

export default async function CompliancePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "compliance:export-evidence-pack")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compliance evidence pack</h1>
        <p className="mt-1 text-sm text-ink/70">
          One-click JSON snapshot of this tenant&apos;s security and compliance
          posture, suitable for SOC 2, ISO 27001, and vendor audit responses.
          Composed on demand from the same sources the admin pages read — no
          new data is collected, no facts are restated.
        </p>
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="text-base font-medium">What&apos;s in the pack</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-ink/80 space-y-1">
            <li>Tenant metadata (slug, name, status, default locale)</li>
            <li>
              Security configuration (TOTP policy, session timeouts, step-up
              window, IP allowlist)
            </li>
            <li>Active membership counts by role and status</li>
            <li>
              Active API keys (name, prefix, scopes, dates) — never hashes or
              secrets
            </li>
            <li>
              Audit chain integrity (event count, latest verification result,
              tamper history)
            </li>
            <li>Encryption-key rotation history</li>
            <li>Sub-processor catalogue + pending change announcements</li>
            <li>DPIA / TIA counts + active Terms versions</li>
            <li>SLA + breach summary (last 90 days, open incidents)</li>
          </ul>
        </div>
        <div>
          <h2 className="text-base font-medium">What it explicitly does not contain</h2>
          <p className="mt-1 text-sm text-ink/70">
            API key hashes or HMAC versions, webhook signing secrets, TOTP seed
            material, OAuth refresh tokens, raw audit-event payloads, or any
            User PII beyond the FIRM_ADMIN membership listing.
          </p>
        </div>
        <DownloadEvidencePackButton tenantSlug={tenantSlug} />
        <p className="text-xs text-ink/60">
          {ALL_SECTIONS.length} sections · generated on demand · the export is
          recorded on this tenant&apos;s audit chain.
        </p>
      </div>
    </div>
  );
}
