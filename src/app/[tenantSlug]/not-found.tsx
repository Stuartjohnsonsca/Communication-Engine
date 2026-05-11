import Link from "next/link";

/**
 * Tenant-scoped 404. Activates for unmatched routes UNDER a tenant
 * slug — e.g. `/acme-firm/typo`. The tenant layout still renders
 * around us, so the sidebar + nav are intact and the User can
 * navigate without bouncing out of the tenant context.
 *
 * Note: this component cannot read the tenantSlug param directly (the
 * `not-found.tsx` API in Next 15 doesn't pass params). Cross-tenant
 * links here are intentionally global.
 */
export default function TenantNotFound() {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-ink/70">
          That page doesn&apos;t exist inside this tenant. It may have been
          renamed, or you may have followed a stale link.
        </p>
      </div>
      <div className="card space-y-2 text-sm text-ink/80">
        <p className="font-medium text-ink">Try one of these:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Use the sidebar to pick the surface you wanted (Drafts, Actions, FCG, etc.).
          </li>
          <li>
            Press{" "}
            <kbd className="rounded border border-ink/15 bg-ink/5 px-1 font-mono text-xs">
              Ctrl/Cmd + K
            </kbd>{" "}
            to open the command palette and search across drafts, members, audit events, and more.
          </li>
          <li>
            <Link href="/" className="underline decoration-dotted">
              Return to home
            </Link>{" "}
            and pick a different tenant.
          </li>
        </ul>
      </div>
    </div>
  );
}
