import Link from "next/link";

/**
 * App Router 404 page (post-PRD hardening).
 *
 * Activates for any unmatched route outside a tenant slug (the per-
 * tenant slug has its own `not-found.tsx` so the sidebar stays
 * available there). Branded copy + a small set of obvious next steps.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-ink/70">
          We can&apos;t find anything at that address. The link may be stale, or
          you may have signed out of the tenant in another tab.
        </p>
      </div>
      <div className="card space-y-3 text-sm">
        <div className="font-medium">Where to go next</div>
        <ul className="list-disc pl-5 text-ink/80 space-y-1">
          <li>
            <Link href="/" className="underline decoration-dotted">
              Home
            </Link>{" "}
            — sign in, or jump back into a tenant you&apos;re a member of.
          </li>
          <li>
            <Link href="/status" className="underline decoration-dotted">
              Service status
            </Link>{" "}
            — current SLA, sub-processors, and recent incidents.
          </li>
          <li>
            <Link href="/login" className="underline decoration-dotted">
              Sign in
            </Link>{" "}
            — if you got here because your session expired.
          </li>
        </ul>
      </div>
    </div>
  );
}
