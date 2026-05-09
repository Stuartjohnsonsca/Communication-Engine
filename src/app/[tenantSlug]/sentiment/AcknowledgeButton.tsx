"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function AcknowledgeButton({
  tenantSlug,
  signalId,
}: {
  tenantSlug: string;
  signalId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function ack() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/sentiment/${signalId}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? res.statusText);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button className="btn text-xs" disabled={pending} onClick={ack}>
        {pending ? "…" : "Acknowledge"}
      </button>
    </div>
  );
}
