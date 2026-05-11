"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary that activates when the root layout
 * itself throws (or anything above the per-segment `error.tsx`).
 *
 * Per the Next 15 contract this MUST render its own `<html>` and
 * `<body>` because the root layout is already broken. Keep the markup
 * tiny + dependency-free — no Tailwind classes (the stylesheet might
 * have failed to load), no Link import, no app-level providers.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[global-error.tsx]", error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          margin: 0,
          padding: "2rem",
          color: "#1a1a1a",
          background: "#fafafa",
        }}
      >
        <main style={{ maxWidth: 560, margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>
            Acumon Communications — service unavailable
          </h1>
          <p style={{ margin: "0 0 1rem", color: "#555" }}>
            The application failed to load. Our operations team has been
            notified.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "0.5rem 0.75rem",
                background: "#1a1a1a",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                padding: "0.5rem 0.75rem",
                background: "#fff",
                color: "#1a1a1a",
                border: "1px solid #ddd",
                borderRadius: 4,
                textDecoration: "none",
                fontSize: "0.875rem",
              }}
            >
              Go home
            </a>
          </div>
          {error.digest && (
            <p style={{ fontSize: "0.75rem", color: "#666" }}>
              Support reference:{" "}
              <code style={{ background: "#eee", padding: "0.125rem 0.25rem", borderRadius: 2 }}>
                {error.digest}
              </code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
