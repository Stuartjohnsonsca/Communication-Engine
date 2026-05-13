"use client";

import { useEffect, useState } from "react";

/**
 * Post-PRD hardening item 82 — client-side live "Xm outstanding"
 * counter for an unacked sentiment escalation.
 *
 * The signal row is rendered server-side with the static escalation
 * timestamp; this component overlays a tick counter so the operator
 * sees pressure mounting between page refreshes. Updates every 10s
 * (fine resolution for sub-hour, coarse enough to not burn battery on
 * a backgrounded tab — and we don't run the interval when the tab is
 * hidden, see below).
 *
 * **Crosses 4h → red text** to match the sidebar badge's stale tone
 * (item 82 paired) and the stale-sweep cron's 4h threshold (item 77).
 * Same number across all three surfaces so the operator's mental
 * model is "4h = bad" everywhere.
 *
 * Tab-visibility gated: a Page-Visibility hidden tab pauses the
 * interval, then immediately re-renders on tab focus. Without this,
 * a backgrounded /sentiment tab burns a tick every 10s for hours.
 *
 * Hydration: the initial render uses `escalatedAt` only (no `Date.now()`
 * at render time would mismatch between server SSR and client hydrate).
 * The component starts displaying live time on the first client-side
 * effect tick, AFTER hydration. Initial display matches the server
 * (showing the static label from `formatOutstanding(initialAge)`).
 */
export function LiveOutstanding({
  escalatedAt,
  initialAgeMs,
}: {
  /** ISO timestamp of `SentimentSignal.escalatedAt`. */
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
      {formatOutstanding(ageMs)} outstanding
    </span>
  );
}

/**
 * Same bracket scheme as `formatTtaDuration` in the metrics lib —
 * `<1m` / `Nm` / `Nh` / `Nd` — but duplicated here to avoid pulling
 * the server-only `@/lib/sentiment/metrics` import (and its
 * transitive Prisma deps) into a `"use client"` bundle. If a third
 * client site needs the formatter, extract to `src/lib/format/duration.ts`
 * and import from both sides.
 */
function formatOutstanding(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${hours}h`;
  const days = Math.round(ms / (24 * 60 * 60_000));
  return `${days}d`;
}
