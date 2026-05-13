"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format/duration";

/**
 * Post-PRD hardening item 87 — client-side live FCG-window deadline
 * label for a draft row on /drafts.
 *
 * Mirrors item 82's `LiveOutstanding` for the sentiment pillar. The
 * row is rendered server-side with the static deadline; this component
 * overlays a tick counter so the Member sees the deadline approaching
 * (or breach widening) between page refreshes.
 *
 * **Three tones, deadline-relative**:
 *   - past deadline → red text + "Xm overdue"
 *   - within DUE_SOON window (24h) → amber + "in Xh"
 *   - further out → neutral + "in Xd"
 *
 * Same threshold (24h) as the `DUE_SOON_HORIZON_HOURS` constant from
 * `@/lib/drafts/triage` — single mental model: amber means "within 24h
 * of the promise" everywhere on /drafts.
 *
 * **10s tick cadence** matches LiveOutstanding so the operator's
 * mental model is consistent across pillars. Tab-visibility gated:
 * a backgrounded tab pauses the interval cleanly, then immediately
 * re-renders on focus (handles multi-hour tab-restore without waiting
 * for the next 10s boundary).
 *
 * **Hydration**: initial render uses `initialNowMs` (computed once
 * server-side via `Date.now()` at page render). The first client effect
 * tick replaces it with `Date.now()` — SSR + hydrate agree on the
 * initial label, then the client takes over.
 */
export function LiveDeadline({
  deadline,
  initialNowMs,
}: {
  /** ISO timestamp of `Draft.fcgWindowDeadline`. */
  deadline: string;
  /** `Date.now()` at the time of server render; threaded so SSR and
   * the first client paint agree on the initial age. The 10s tick
   * replaces it with the real `Date.now()`. */
  initialNowMs: number;
}) {
  const deadlineMs = Date.parse(deadline);
  const [nowMs, setNowMs] = useState(initialNowMs);

  useEffect(() => {
    if (Number.isNaN(deadlineMs)) return;

    function tick() {
      setNowMs(Date.now());
    }
    tick();

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
  }, [deadlineMs]);

  if (Number.isNaN(deadlineMs)) return null;

  const diffMs = deadlineMs - nowMs;
  const absMs = Math.abs(diffMs);
  const overdue = diffMs < 0;
  // 24h matches DUE_SOON_HORIZON_HOURS in @/lib/drafts/triage.
  const dueSoon = !overdue && diffMs < 24 * 60 * 60_000;

  const label = overdue
    ? `${formatDuration(absMs)} overdue`
    : `in ${formatDuration(absMs)}`;

  const tone = overdue
    ? "tag bg-red-100 text-red-900 tabular-nums"
    : dueSoon
      ? "tag bg-amber-100 text-amber-900 tabular-nums"
      : "tag tabular-nums";

  return (
    <span className={tone} title={`Deadline ${deadline}`}>
      {label}
    </span>
  );
}
