/**
 * Post-PRD hardening item 87 — shared duration formatter.
 *
 * Five sites grew the same `<1m` / `Nm` / `Nh` / `Nd` bracket scheme
 * before this extraction:
 *
 *   1. `src/lib/sentiment/metrics.ts` (`formatTtaDuration`)
 *   2. `src/lib/sentiment/responses-export.ts` (`formatDurationLabel`)
 *   3. `src/lib/drafts/misses-export.ts` (`formatLateBy`)
 *   4. `src/app/[tenantSlug]/admin/drafts/page.tsx` (`formatLateBy`)
 *   5. `src/app/[tenantSlug]/sentiment/LiveOutstanding.tsx` (`formatOutstanding`)
 *
 * Items 78 / 82 / 83 each acknowledged the duplication and explicitly
 * deferred extraction to "the next caller." Item 87 introduces a sixth
 * caller (the new `<LiveDeadline />` per-row countdown on /drafts) and
 * trips the threshold.
 *
 * **Why a separate module rather than re-exporting from
 * `@/lib/sentiment/metrics`?** Two of the callers — `LiveOutstanding`
 * and (now) `LiveDeadline` — are `"use client"` components. Importing
 * from the sentiment metrics module would drag Prisma + server-only
 * code into the client bundle. This file is intentionally zero-dep:
 * pure numeric math, safe on both sides of the server/client boundary.
 */

/**
 * Render a positive duration as a short `<1m` / `Nm` / `Nh` / `Nd`
 * label.
 *
 * **Boundary rule**: durations strictly below 60_000ms collapse to
 * `<1m` — including 30s, 45s, even 59.999s. Previously the drafts
 * callers (`formatLateBy` + `formatDurationLabel`) ran `Math.round` on
 * the minutes first and so rendered 35s as `"1m"`. The sentiment
 * callers (`formatTtaDuration` + `formatOutstanding`) used the strict
 * `ms < 60_000` check and rendered 35s as `"<1m"`. The strict version
 * is the honest one — calling a 35-second response "1m late" is
 * misleading — so the unified formatter adopts it. This is a small
 * semantic tighten for the drafts CSV / page (only affects rows
 * resolved at sub-minute precision, which are essentially noise).
 *
 * Negative inputs floor to 0 (clamped at `<1m`); callers that compute
 * `sentMarkedAt - deadline` for a draft sent JUST under the wire could
 * otherwise pass in `-100ms` due to clock skew or rounding and get a
 * negative-minutes label.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${hours}h`;
  const days = Math.round(ms / (24 * 60 * 60_000));
  return `${days}d`;
}

/**
 * Same bracketing as `formatDuration`, but `null` renders as the
 * em-dash placeholder used by the sentiment response-time card +
 * /account self-view when no data is available (e.g. `medianAckMs`
 * is null because no signal has been acknowledged in the window).
 *
 * Rendering null as `"—"` rather than `"0"` is load-bearing: a
 * "0m TTA" reads as "we acked instantly," whereas `"—"` reads as
 * "no data" — those are operationally distinct.
 */
export function formatDurationOrDash(ms: number | null): string {
  if (ms === null) return "—";
  return formatDuration(ms);
}
