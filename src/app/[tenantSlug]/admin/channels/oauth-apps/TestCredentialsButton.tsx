"use client";

import { useState, useTransition } from "react";

/**
 * Item 109 — pre-flight validator button on /admin/channels/oauth-apps.
 *
 * Calls POST /api/admin/channels/oauth-apps/validate which runs
 * format + (Microsoft only) live discovery checks against the
 * already-saved ChannelOAuthApp row. Renders green / yellow / red
 * inline so a FIRM_ADMIN can confirm pasted credentials before
 * handing the URL to staff.
 *
 * Disabled when the row isn't configured yet (nothing to validate).
 */
export function TestCredentialsButton({
  tenantSlug,
  channelKind,
  disabled,
}: {
  tenantSlug: string;
  channelKind: string;
  disabled?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | null
    | {
        ok: boolean;
        errors: string[];
        warnings: string[];
      }
  >(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/channels/oauth-apps/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug, channelKind }),
        });
        const data = (await res.json().catch(() => ({}))) as
          | { ok?: boolean; errors?: string[]; warnings?: string[]; error?: string };
        if (!res.ok) {
          setResult({
            ok: false,
            errors: [data.error ?? `HTTP ${res.status}`],
            warnings: [],
          });
          return;
        }
        setResult({
          ok: data.ok ?? false,
          errors: data.errors ?? [],
          warnings: data.warnings ?? [],
        });
      } catch (e) {
        setResult({
          ok: false,
          errors: [e instanceof Error ? e.message : "validation failed"],
          warnings: [],
        });
      }
    });
  }

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={disabled || isPending}
        className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {isPending ? "Checking…" : "Test credentials"}
      </button>
      {result && (
        <div
          className={`rounded border px-3 py-2 text-xs ${
            result.ok && result.warnings.length === 0
              ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200"
              : result.ok
                ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
                : "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200"
          }`}
        >
          {result.ok && result.warnings.length === 0 ? (
            <strong>✓ Looks good.</strong>
          ) : result.ok ? (
            <strong>⚠ Saved with warnings:</strong>
          ) : (
            <strong>✗ Won&rsquo;t work as configured:</strong>
          )}
          {result.errors.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {result.errors.map((e, i) => (
                <li key={`e${i}`}>{e}</li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {result.warnings.map((w, i) => (
                <li key={`w${i}`}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
