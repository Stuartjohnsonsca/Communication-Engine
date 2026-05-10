"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props =
  | { tenantSlug: string; kind: "mark-all-read" }
  | { tenantSlug: string; kind: "mark-one-read"; id: string };

export default function NotificationActions(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function markAllRead() {
    setError(null);
    const res = await fetch("/api/notifications/read-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantSlug: props.tenantSlug }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    startTransition(() => router.refresh());
  }

  async function markOneRead() {
    if (props.kind !== "mark-one-read") return;
    setError(null);
    const res = await fetch(`/api/notifications/${props.id}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantSlug: props.tenantSlug }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    startTransition(() => router.refresh());
  }

  if (props.kind === "mark-all-read") {
    return (
      <button
        type="button"
        className="btn text-xs"
        onClick={markAllRead}
        disabled={pending}
      >
        {pending ? "Marking…" : "Mark all read"}
        {error && <span className="ml-2 text-red-600">· {error}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="text-xs underline decoration-dotted"
      onClick={markOneRead}
      disabled={pending}
    >
      {pending ? "…" : "mark read"}
      {error && <span className="ml-2 text-red-600">· {error}</span>}
    </button>
  );
}
