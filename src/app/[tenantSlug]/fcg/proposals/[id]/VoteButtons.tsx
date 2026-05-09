"use client";

import { useTransition, useState } from "react";

export default function VoteButtons({
  tenantSlug,
  proposalId,
}: {
  tenantSlug: string;
  proposalId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function vote(decision: "APPROVE" | "REJECT" | "ABSTAIN") {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/fcg/proposals/${proposalId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug, decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(`Error: ${data.error ?? res.statusText}`);
        return;
      }
      setMsg(
        data.proposalState
          ? `Vote recorded. Proposal is now ${data.proposalState} (${data.reason ?? ""}).`
          : "Vote recorded.",
      );
      // refresh the page after a short delay
      setTimeout(() => window.location.reload(), 600);
    });
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="btn btn-primary" disabled={pending} onClick={() => vote("APPROVE")}>
        Approve
      </button>
      <button className="btn" disabled={pending} onClick={() => vote("REJECT")}>
        Reject
      </button>
      <button className="btn" disabled={pending} onClick={() => vote("ABSTAIN")}>
        Abstain
      </button>
      {msg && <span className="self-center text-sm">{msg}</span>}
    </div>
  );
}
