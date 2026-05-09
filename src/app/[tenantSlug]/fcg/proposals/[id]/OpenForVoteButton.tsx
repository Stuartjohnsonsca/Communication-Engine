"use client";

import { useState, useTransition } from "react";

export default function OpenForVoteButton({
  tenantSlug,
  proposalId,
}: {
  tenantSlug: string;
  proposalId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function open() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/fcg/proposals/${proposalId}/open?tenant=${encodeURIComponent(tenantSlug)}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Error: ${data.error ?? res.statusText}`);
        return;
      }
      window.location.reload();
    });
  }

  return (
    <div className="mt-3 flex items-center gap-3">
      <button className="btn btn-primary" disabled={pending} onClick={open}>
        {pending ? "Opening…" : "Open for vote"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
