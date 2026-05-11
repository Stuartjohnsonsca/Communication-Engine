"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Tenant-scoped error boundary. Activates when a server component,
 * server action, or client component under `/[tenantSlug]/...`
 * throws — the tenant layout (sidebar, nav) stays intact so the User
 * can navigate without bouncing out of context.
 */
export default function TenantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[tenant error.tsx]", error);
    }
  }, [error]);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink/70">
          This page hit an error before it could finish. Your sidebar is still
          available — pick a different surface, or try again.
        </p>
      </div>
      <div className="card space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary text-sm" onClick={reset}>
            Try again
          </button>
          <Link href="/" className="btn text-sm">
            Go home
          </Link>
        </div>
        {error.digest && (
          <div className="text-xs text-ink/60">
            <div className="uppercase tracking-wide text-ink/50">Support reference</div>
            <code className="mt-1 inline-block break-all rounded bg-ink/5 px-2 py-1 font-mono">
              {error.digest}
            </code>
            <p className="mt-2 text-ink/60">
              Quote this if you ask your Firm Administrator for help — it lets
              the audit log pinpoint the failing request without you describing
              it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
