"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function PerfOptInToggle({
  tenantSlug,
  initial,
}: {
  tenantSlug: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [optedIn, setOptedIn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(next: boolean) {
    setError(null);
    const previous = optedIn;
    setOptedIn(next);
    startTransition(async () => {
      const res = await fetch("/api/membership/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, perfDashOptIn: next }),
      });
      if (!res.ok) {
        setOptedIn(previous);
        const data = await res.json().catch(() => ({}));
        setError(`Could not save: ${data.error ?? res.statusText}`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Performance dashboard opt-in</h2>
          <p className="mt-1 text-xs text-ink/60">
            Per PRD §9.2, the Firm Culture Team can only see your <em>per-User</em> adherence
            scores if you opt in here. Without opt-in, your scores still inform aggregate firm
            numbers, but the FCT row for you shows &ldquo;opt-in required&rdquo;. Individual scores
            are also only ever shown monthly in arrears, never in real time.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={optedIn}
            onChange={(e) => toggle(e.target.checked)}
            disabled={pending}
          />
          <span>{optedIn ? "Opted in" : "Not opted in"}</span>
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
