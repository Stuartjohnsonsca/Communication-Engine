"use client";

import { useState, useTransition } from "react";

/**
 * Item 104 — admin force-revoke a per-Member ChannelAuth from
 * /admin/channels/members. POSTs to the same disconnect endpoint as
 * the self-revoke /account button — endpoint discriminates self vs
 * admin via `auth.membershipId === ctx.membership.id` and writes
 * `byActor: "admin"` for cross-Member revocations.
 */
export function AdminRevokeButton({
  authId,
  channelId,
  tenantSlug,
  memberName,
  channelKind,
}: {
  authId: string;
  channelId: string;
  tenantSlug: string;
  memberName: string;
  channelKind: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke() {
    setError(null);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Force-revoke ${memberName}'s ${channelKind} auth? They will need to re-connect themselves before ingest from their account resumes.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/disconnect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantSlug,
            authId,
            reason: "admin force-revoke",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `revoke failed (${res.status})`);
          return;
        }
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "revoke failed");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={revoke}
        disabled={isPending}
        className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20"
      >
        {isPending ? "…" : "Revoke"}
      </button>
      {error && (
        <span className="max-w-xs text-right text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
