"use client";

import { useState, useTransition } from "react";

/**
 * Item 110 — staff-self-service IMAP credential entry / re-entry.
 *
 * Sibling to `ConnectChannelButtons.tsx` (OAuth path); rendered on
 * /account when the channel kind is IMAP. Always shows the form
 * (even when already connected) because the only "connect" action
 * for password channels IS entering the credentials — there's no
 * OAuth handshake to redirect to.
 *
 * On submit: POST /api/channels/[id]/connect-imap. On success:
 * window.location.reload() so the page refreshes with the new
 * `nextReauthAt` and clears any prior failure prompt.
 *
 * The password input is `type="password" autoComplete="new-password"`
 * — never displayed back even after save. Submission goes over HTTPS;
 * encryption at rest happens server-side via `encryptJson`.
 */
export function ConnectImapForm({
  channelId,
  tenantSlug,
  channelKind,
  imapConfigSummary,
  hasExistingAuth,
  hasFailure,
  failureReason,
}: {
  channelId: string;
  tenantSlug: string;
  channelKind: string;
  imapConfigSummary: string | null;
  hasExistingAuth: boolean;
  hasFailure: boolean;
  failureReason?: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Username and password are both required.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/connect-imap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `connect failed (${res.status})`);
          return;
        }
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "connect failed");
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {imapConfigSummary && (
        <div className="text-xs text-ink/60">
          Server: <code>{imapConfigSummary}</code>
        </div>
      )}
      {hasFailure && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          <strong>Connection broken — re-enter your password to resume ingest.</strong>
          {failureReason && (
            <div className="mt-1 text-red-700 dark:text-red-300">
              Server said: {failureReason}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs">
          <span className="block text-ink/70">Mailbox username / email</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="staff@firm.example.com"
            className="mt-1 w-full rounded border border-ink/15 bg-white px-2 py-1 text-sm dark:border-ink/30 dark:bg-zinc-900"
            required
          />
        </label>
        <label className="flex-1 text-xs">
          <span className="block text-ink/70">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="never displayed back"
            className="mt-1 w-full rounded border border-ink/15 bg-white px-2 py-1 text-sm dark:border-ink/30 dark:bg-zinc-900"
            required
          />
        </label>
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? "…" : hasExistingAuth ? "Re-enter" : `Connect ${channelKind}`}
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-700 dark:text-red-300">{error}</div>
      )}
    </form>
  );
}
