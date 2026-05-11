"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * App Router error boundary (post-PRD hardening).
 *
 * Catches any uncaught error from a server component, server action,
 * or client component within the root layout. Renders branded copy +
 * the Next-supplied `error.digest` so support can correlate the
 * report to the entry on the audit / observability pipeline (item 4's
 * reportError plus item 36's instrumentation.ts already routed the
 * raw error there; the digest is the user-visible reference).
 *
 * MUST be a Client Component per the Next 15 App Router contract.
 */
export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Belt-and-braces console hint. The actual report is fired by
    // `instrumentation.ts onRequestError` for server-thrown errors;
    // a client-thrown error reaches this boundary only and is logged
    // here so it shows up in browser DevTools for any operator
    // shoulder-surfing a Client.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[error.tsx]", error);
    }
  }, [error]);

  return (
    <div className="mx-auto max-w-xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink/70">
          The page hit an error before it could finish loading. Our operations
          team has been notified — no action required on your side. You can try
          again or head back to the dashboard.
        </p>
      </div>

      <div className="card space-y-3">
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
              Quote this reference if you contact your Firm Administrator or
              Acumon support — it lets us trace the exact request in the audit
              log without you having to describe the failure.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
