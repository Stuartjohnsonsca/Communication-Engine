"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function AcknowledgeButton({
  tenantSlug,
  adherenceId,
}: {
  tenantSlug: string;
  adherenceId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function acknowledge() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/adherence/${adherenceId}/acknowledge`, {
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
      <button className="btn btn-primary text-xs" onClick={acknowledge} disabled={pending}>
        {pending ? "…" : "Acknowledge"}
      </button>
      {error && <span className="text-xs text-red-700">{String(error)}</span>}
    </div>
  );
}
