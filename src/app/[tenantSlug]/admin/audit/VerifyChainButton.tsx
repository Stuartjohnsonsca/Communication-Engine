"use client";

import { useState, useTransition } from "react";

type VerifyResult = {
  ok: boolean;
  failedAt: number | null;
  eventCount: number;
  latestSeq: number | null;
  tookMs: number;
  verifiedAt: string;
};

export default function VerifyChainButton({ tenantSlug }: { tenantSlug: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function verify() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await fetch("/api/audit/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Verification failed: ${data.error ?? res.statusText}`);
        return;
      }
      setResult(await res.json());
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button className="btn" onClick={verify} disabled={pending}>
        {pending ? "Verifying…" : "Verify chain"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {result && (
        <p
          className={`text-xs ${
            result.ok ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {result.ok
            ? `OK — ${result.eventCount} events verified in ${result.tookMs} ms`
            : `Chain broken at seq ${result.failedAt}`}
        </p>
      )}
    </div>
  );
}
