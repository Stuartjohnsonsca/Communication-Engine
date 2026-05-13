"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format/duration";

/**
 * Post-PRD hardening items 82 + 94 — client-side live "Xm outstanding"
 * counter for an unacked escalation.
 *
 * Originally shipped at `src/app/[tenantSlug]/sentiment/LiveOutstanding.tsx`
 * for item 82's near-live sentiment feedback. Item 94 promotes it to a
 * shared component so /adherence/escalations can mount the same logic
 * without duplicating it — mirrors item 87's promotion of `AutoRefresh`
 * to `src/components/` once a second surface needed it. The component is
 * already pillar-agnostic; only its file location changed.
 *
 * The row is rendered server-side with the static escalation timestamp;
 * this component overlays a tick counter so the operator sees pressure
 * mounting between page refreshes. Updates every 10s (fine resolution
 * for sub-hour, coarse enough to not burn battery on a backgrounded
 * tab — and we don't run the interval when the tab is hidden, see
 * below).
 *
 * **Crosses 4h → red text** to match the sidebar badge's stale tone
 * (items 82 + 94 paired) and the sentiment stale-sweep cron's 4h
 * threshold (item 77). Same number across every surface so the
 * operator's mental model is "4h = bad" everywhere. Adherence has no
 * stale-sweep cron of its own yet (a future item analogous to 77 /
 * 84), but the badge + per-row tone agree at 4h regardless.
 *
 * Tab-visibility gated: a Page-Visibility hidden tab pauses the
 * interval, then immediately re-renders on tab focus. Without this,
 * a backgrounded tab burns a tick every 10s for hours.
 *
 * Hydration: the initial render uses `escalatedAt` only (no `Date.now()`
 * at render time would mismatch between server SSR and client hydrate).
 * The component starts displaying live time on the first client-side
 * effect tick, AFTER hydration. Initial display matches the server
 * (showing the static label from `formatDuration(initialAge)`).
 */
export function LiveOutstanding({
  escalatedAt,
  initialAgeMs,
}: {
  /** ISO timestamp of `escalatedAt` on the underlying row
   * (`SentimentSignal` or `CommunicationAdherence`). Parameter name
   * stays generic because both pillars share the column. */
  escalatedAt: string;
  /** Computed server-side as `now - escalatedAt`; the initial render
   * value so SSR/hydration agree. The client-side tick replaces this
   * with `Date.now() - escalatedAt` on the first effect run. */
  initialAgeMs: number;
}) {
  const [ageMs, setAgeMs] = useState(initialAgeMs);

  useEffect(() => {
    const escalatedMs = Date.parse(escalatedAt);
    if (Number.isNaN(escalatedMs)) return;

    function tick() {
      setAgeMs(Date.now() - escalatedMs);
    }
    tick(); // immediate update on mount (handles tab-restore-after-hours)

    let interval: ReturnType<typeof setInterval> | null = null;
    function start() {
      stop();
      interval = setInterval(tick, 10_000);
    }
    function stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }
    function onVis() {
      if (document.visibilityState === "visible") {
        tick();
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
  }, [escalatedAt]);

  const stale = ageMs > 4 * 60 * 60_000;
  return (
    <span
      className={
        stale
          ? "tabular-nums text-red-900 font-medium"
          : "tabular-nums text-ink/70"
      }
      title={`Escalated ${escalatedAt}`}
    >
      {formatDuration(ageMs)} outstanding
    </span>
  );
}
