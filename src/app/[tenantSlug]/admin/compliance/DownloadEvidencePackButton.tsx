"use client";

import { useState } from "react";

/**
 * Client-side download trigger for the compliance evidence pack.
 *
 * Posts to `/api/compliance/evidence-pack` and saves the JSON response
 * to disk via a temporary object URL. Lives on the client (not as a
 * server-action form post) because Server Actions in Next 15 can only
 * return `void | Promise<void>` to a `<form action>`; we need to stream
 * a Response back to the user.
 */
export function DownloadEvidencePackButton({ tenantSlug }: { tenantSlug: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/evidence-pack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const filename =
        parseFilenameFromContentDisposition(res.headers.get("content-disposition")) ??
        `acumon-evidence-pack-${tenantSlug}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn btn-primary text-sm"
        onClick={onClick}
        disabled={busy}
      >
        {busy ? "Generating…" : "Download evidence pack (JSON)"}
      </button>
      {error && (
        <p className="text-sm text-red-700">Download failed: {error}</p>
      )}
    </div>
  );
}

function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match ? match[1] : null;
}
