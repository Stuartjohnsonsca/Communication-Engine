"use client";

import { useState, useTransition } from "react";

/**
 * Item 110 — User extends their personal `nextReauthAt` later than
 * the current deadline. Cannot reduce; cannot dip below tenant
 * floor (both invariants enforced server-side in
 * `extendReauthDeadline`).
 *
 * UI: dropdown of extension durations. The dropdown options are
 * relative to NOW (e.g. "60 days from today") so the User picks a
 * concrete future date. Server compares against the existing
 * deadline + the tenant floor and either accepts or rejects with
 * a specific error message.
 */
export function ExtendReauthButton({
  authId,
  channelId,
  tenantSlug,
  currentReauthAt,
  tenantFloorDays,
}: {
  authId: string;
  channelId: string;
  tenantSlug: string;
  currentReauthAt: string;
  tenantFloorDays: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [chosenDays, setChosenDays] = useState<number>(
    Math.max(60, tenantFloorDays),
  );

  // Options must respect the tenant floor — anything below it is
  // rejected server-side anyway, so don't offer.
  const dayOptions = [60, 90, 120, 180, 365].filter(
    (d) => d >= tenantFloorDays,
  );

  function submit() {
    setError(null);
    const target = new Date(Date.now() + chosenDays * 24 * 60 * 60 * 1000);
    if (target <= new Date(currentReauthAt)) {
      setError(
        `Extension must be later than the current deadline (${currentReauthAt}). Pick a longer duration.`,
      );
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/channels/${channelId}/extend-reauth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantSlug,
            authId,
            requestedNextReauthAt: target.toISOString(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? `extend failed (${res.status})`);
          return;
        }
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "extend failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <select
          value={chosenDays}
          onChange={(e) => setChosenDays(Number(e.target.value))}
          disabled={isPending}
          className="rounded border border-ink/15 bg-white px-2 py-1 text-xs dark:border-ink/30 dark:bg-zinc-900"
        >
          {dayOptions.map((d) => (
            <option key={d} value={d}>
              {d} days from now
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="rounded border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/20"
        >
          {isPending ? "…" : "Extend"}
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-700 dark:text-red-300">{error}</div>
      )}
    </div>
  );
}
