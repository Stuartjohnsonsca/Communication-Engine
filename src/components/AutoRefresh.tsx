"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Post-PRD hardening items 82 + 87 — visibility-gated periodic refresh
 * of a server-rendered page.
 *
 * Originally shipped at `src/app/[tenantSlug]/sentiment/AutoRefresh.tsx`
 * for item 82's near-live sentiment feedback. Item 87 promotes it to a
 * shared component so the new /drafts page near-live feedback can mount
 * the same logic without duplicating it — and so a future surface (e.g.
 * /admin/health, /admin/drafts) can opt in with one import.
 *
 * Behaviour: calls `router.refresh()` every `intervalMs` (default 60s)
 * while the tab is visible. `router.refresh()` re-fetches the server
 * component tree on the current route — so the page's server-rendered
 * data updates without a hard navigation, preserving scroll position
 * and any client state.
 *
 * **Why not poll a JSON endpoint?** Two reasons. (1) The existing
 * server components already do the right joins + RBAC scoping, so
 * `router.refresh()` reuses that logic verbatim — building a `/api/X/
 * live` would duplicate it. (2) Pages compose server components that
 * read auth/tenant context from request-scoped cookies; a client-side
 * fetch would need to thread that context back — which is exactly what
 * `router.refresh()` already does.
 *
 * **Why visibility-gated?** A tab left open in the background shouldn't
 * burn one server round-trip per minute forever. The Page Visibility
 * API drives the interval lifecycle — backgrounded tabs pause cleanly,
 * foregrounded tabs immediately refresh once on focus (so a Member
 * returning to the tab after an hour sees a fresh snapshot without
 * having to manually reload).
 *
 * **Why 60s default?** 10s would feel snappy but pulse the DB with N
 * concurrent tabs × 6/min × every query the page runs. 60s is fast
 * enough that an externally-acked signal or just-sent draft disappears
 * within a minute, and per-row live counters (LiveOutstanding,
 * LiveDeadline) provide the visceral "time passing" cue between
 * refreshes.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      stop();
      interval = setInterval(() => {
        router.refresh();
      }, intervalMs);
    }
    function stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }
    function onVis() {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, router]);

  return null;
}
