import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { redirect } from "next/navigation";

/**
 * Shown when the tenant layout denies a request because the caller's IP
 * isn't in the tenant allowlist (post-PRD hardening item 17).
 *
 * The page is on the layout's allowlist of paths that bypass the IP
 * check, so a denied User can read this and understand WHY they were
 * locked out instead of seeing a generic redirect loop. We still
 * require a valid session — anonymous traffic hits /login, not here.
 */
export default async function AccessDeniedPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ reason?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Access denied</h1>
      <p className="text-sm text-ink/70">
        Your network address is not in the IP allowlist configured for
        the <strong>{ctx.tenant.name}</strong> tenant. Sessions and API
        keys are both restricted by the same list, so this also affects
        programmatic callers.
      </p>
      {sp.reason && (
        <div className="rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs font-mono text-amber-900">
          {sp.reason}
        </div>
      )}
      <div className="card space-y-2 text-sm">
        <p className="font-medium">What to do</p>
        <ul className="list-disc space-y-1 pl-5 text-ink/70">
          <li>Connect via your firm's VPN or office network if the allowlist is configured against it.</li>
          <li>
            Ask a Firm Administrator to add your IP at{" "}
            <code className="rounded bg-ink/5 px-1 text-xs">/admin/security</code>.
            FIRM_ADMIN access from a permitted network is the only way
            to change this list.
          </li>
          <li>
            If you are a Firm Administrator who has locked yourself out, contact
            support — recovery requires direct database intervention.
          </li>
        </ul>
      </div>
      <p className="text-xs text-ink/50">
        <Link href={`/${tenantSlug}/account`} className="underline">/account</Link>{" "}
        and the 2FA challenge page remain reachable in case you need to
        sign out or rotate your second factor — but tenant pages do
        not, by design.
      </p>
    </div>
  );
}
