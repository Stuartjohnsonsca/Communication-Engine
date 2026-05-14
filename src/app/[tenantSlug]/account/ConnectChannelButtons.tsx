"use client";

import { useState, useTransition } from "react";

/**
 * Item 104 — client-side Connect/Disconnect buttons for /account's
 * "Connect provider accounts" section.
 *
 * Connect: POST /api/channels/[id]/connect → server returns
 * `{redirectTo}` for the OAuth handshake; we navigate the browser
 * there (provider's consent screen). After consent, the OAuth
 * callback route persists the per-Member ChannelAuth and redirects
 * back to /admin/channels — operator can also redirect callers back
 * to /account in a future iteration.
 *
 * Disconnect: POST /api/channels/[id]/disconnect → soft-revokes the
 * ChannelAuth. Reloads the page on success so the row updates.
 */
export function ConnectChannelButtons({
  channelId,
  tenantSlug,
  authId,
  channelKind,
}: {
  channelId: string;
  tenantSlug: string;
  authId: string | null;
  channelKind: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function connect() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, mode: "real" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `connect failed (${res.status})`);
          return;
        }
        if (data.redirectTo) {
          window.location.href = data.redirectTo;
          return;
        }
        // No redirect URL = mock-mode fallback or OAuth not configured.
        setError(
          "OAuth flow could not start. Ask your Firm Administrator to configure the provider app on /admin/channels/oauth-apps.",
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "connect failed");
      }
    });
  }

  function disconnect() {
    if (!authId) return;
    setError(null);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Disconnect your ${channelKind} account? Ingest from your mailbox will stop. You can reconnect at any time.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/disconnect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, authId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `disconnect failed (${res.status})`);
          return;
        }
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "disconnect failed");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {authId ? (
        <button
          type="button"
          onClick={disconnect}
          disabled={isPending}
          className="rounded border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
        >
          {isPending ? "…" : "Disconnect"}
        </button>
      ) : (
        <button
          type="button"
          onClick={connect}
          disabled={isPending}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? "…" : `Connect ${channelKind}`}
        </button>
      )}
      {error && (
        <span className="max-w-xs text-right text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
