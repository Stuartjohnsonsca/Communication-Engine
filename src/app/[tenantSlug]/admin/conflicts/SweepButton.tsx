"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function SweepButton({ tenantSlug }: { tenantSlug: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-ink/60">{msg}</span>}
      <button
        className="btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMsg(null);
            const res = await fetch("/api/ucg/sweep-conflicts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tenantSlug }),
            });
            if (!res.ok) {
              setMsg(`Failed: ${res.status}`);
              return;
            }
            const data = await res.json();
            setMsg(`Swept ${data.ucgsSwept} UCG(s); suspended ${data.rulesSuspended} rule(s)`);
            router.refresh();
          })
        }
      >
        {pending ? "Sweeping…" : "Run grace-period sweep"}
      </button>
    </div>
  );
}
