"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Post-PRD hardening item 82 — visibility-gated periodic refresh of the
 * /sentiment page.
 *
 * Calls `router.refresh()` every `intervalMs` (default 60s) when the
 * tab is visible. `router.refresh()` re-fetches the server component
 * tree on the current route — so the response-time card, per-Member
 * table, and signal list all update with fresh data without a hard
 * navigation. Newly-escalated signals appear; acked ones drop from the
 * Escalated filter; the badge's stale tone updates with the layout.
 *
 * **Why not poll a JSON endpoint?** Two reasons. (1) The existing
 * server components already do the right joins + RBAC scoping, so
 * `router.refresh()` reuses that logic verbatim — building a `/api/
 * sentiment/live` would duplicate it. (2) The page is composed of
 * server components that read auth/tenant context from request-scoped
 * cookies; a client-side fetch would need to thread that context back
 * which is exactly what `router.refresh()` already does.
 *
 * **Why visibility-gated?** A /sentiment tab left open in the
 * background shouldn't burn one server round-trip per minute forever.
 * The Page Visibility API drives the interval lifecycle — backgrounded
 * tabs pause cleanly, foregrounded tabs immediately refresh once on
 * focus (so a Member returning to the tab after an hour sees a fresh
 * snapshot without having to manually reload).
 *
 * **Why 60s, not 10s?** 10s would feel snappy but pulse the DB with N
 * concurrent /sentiment tabs × 6/min × every query the page runs. 60s
 * is fast enough that an acked signal disappears within a minute of
 * the operator clicking ack on another device, and the `LiveOutstanding`
 * per-row tick (10s) gives the visceral "time passing" cue between
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
        // Immediate refresh on tab focus — a Member returning to a
        // long-backgrounded tab gets a fresh snapshot at click-time.
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
