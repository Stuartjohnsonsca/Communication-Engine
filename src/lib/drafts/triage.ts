/**
 * Post-PRD hardening item 64 — FCG-deadline triage for the Member
 * drafts inbox.
 *
 * The engine's central promise is "respond within the FCG window."
 * The /drafts page must surface that promise: an overdue draft is
 * not the same kind of thing as one due tomorrow, and the page that
 * Members open daily should make the urgency obvious without a
 * single click.
 *
 * Pure functions over a minimal Draft shape so the same logic is
 * usable by the page + future tests + future webhook digest work
 * without dragging in a Prisma type.
 */

/** Minimal shape — anything Prisma-shaped is assignable. */
export type TriageDraft = {
  id: string;
  status: string;
  fcgWindowDeadline: Date | null;
  sentMarkedAt: Date | null;
  createdAt: Date;
};

export type TriageBucket = "overdue" | "due_soon" | "open" | "recently_closed";

/// Drafts within this many hours of their deadline are "due soon"
/// rather than "open." Twenty-four hours is the natural cadence for
/// most FCG response windows (PRD §7.2 default).
export const DUE_SOON_HORIZON_HOURS = 24;

/// Recently-closed drafts older than this drop off the page. Seven
/// days is enough to feel like "today + this week" context without
/// pushing the open buckets below the fold.
export const RECENTLY_CLOSED_HORIZON_DAYS = 7;

const TERMINAL_STATUSES = new Set(["SENT", "DISCARDED"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Classify a single draft into a triage bucket given the current
 * wall-clock. Exported so the page renderer + tests share one rule.
 *
 * Rule:
 *   - terminal (SENT/DISCARDED) within the recently-closed horizon
 *     → "recently_closed". Older terminals are not returned by this
 *     function (callers filter at query time).
 *   - non-terminal + deadline past `now`                → "overdue"
 *   - non-terminal + deadline within next horizon hours → "due_soon"
 *   - otherwise (no deadline, or deadline > horizon)    → "open"
 */
export function classifyDraft(draft: TriageDraft, now: Date = new Date()): TriageBucket {
  if (isTerminalStatus(draft.status)) {
    return "recently_closed";
  }
  if (!draft.fcgWindowDeadline) {
    return "open";
  }
  const deadlineMs = draft.fcgWindowDeadline.getTime();
  const nowMs = now.getTime();
  if (deadlineMs < nowMs) return "overdue";
  if (deadlineMs - nowMs <= DUE_SOON_HORIZON_HOURS * 60 * 60 * 1000) {
    return "due_soon";
  }
  return "open";
}

/**
 * Split a flat draft list into the four buckets. Each bucket is
 * sorted for the page: overdue → most overdue first, due_soon →
 * soonest deadline first, open → soonest deadline first then
 * createdAt desc for the no-deadline tail, recently_closed →
 * sentMarkedAt desc (createdAt as fallback).
 *
 * Returns plain arrays so the renderer can `.map` without a wrapper
 * type. Counts are O(1) via `.length`.
 */
export function bucketDrafts<T extends TriageDraft>(
  drafts: T[],
  now: Date = new Date(),
): Record<TriageBucket, T[]> {
  const overdue: T[] = [];
  const dueSoon: T[] = [];
  const open: T[] = [];
  const recentlyClosed: T[] = [];

  for (const d of drafts) {
    const bucket = classifyDraft(d, now);
    if (bucket === "overdue") overdue.push(d);
    else if (bucket === "due_soon") dueSoon.push(d);
    else if (bucket === "open") open.push(d);
    else recentlyClosed.push(d);
  }

  overdue.sort(
    (a, b) =>
      (a.fcgWindowDeadline?.getTime() ?? 0) - (b.fcgWindowDeadline?.getTime() ?? 0),
  );
  dueSoon.sort(
    (a, b) =>
      (a.fcgWindowDeadline?.getTime() ?? Number.POSITIVE_INFINITY) -
      (b.fcgWindowDeadline?.getTime() ?? Number.POSITIVE_INFINITY),
  );
  open.sort((a, b) => {
    const ad = a.fcgWindowDeadline?.getTime();
    const bd = b.fcgWindowDeadline?.getTime();
    if (ad != null && bd != null) return ad - bd;
    if (ad != null) return -1; // deadlines before no-deadlines
    if (bd != null) return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  recentlyClosed.sort(
    (a, b) =>
      (b.sentMarkedAt?.getTime() ?? b.createdAt.getTime()) -
      (a.sentMarkedAt?.getTime() ?? a.createdAt.getTime()),
  );

  return {
    overdue,
    due_soon: dueSoon,
    open,
    recently_closed: recentlyClosed,
  };
}

/**
 * Render a deadline as a short relative string for the page. Past
 * deadlines render as "12h overdue" / "3d overdue"; future as "in
 * 4h" / "in 2d". Sub-minute precision collapses to "now"; sub-hour
 * to "Nm" so a draft due in 45 min reads "in 45m" not "in 0.75h".
 *
 * Pure UTC math — no timezone. The page also shows the absolute
 * timestamp inline for unambiguous reading.
 */
export function formatDeadlineRelative(
  deadline: Date,
  now: Date = new Date(),
): string {
  const diffMs = deadline.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60_000);
  const hours = Math.round(absMs / (60 * 60_000));
  const days = Math.round(absMs / (24 * 60 * 60_000));
  let label: string;
  if (minutes < 1) label = "now";
  else if (minutes < 60) label = `${minutes}m`;
  else if (hours < 48) label = `${hours}h`;
  else label = `${days}d`;
  if (label === "now") return "now";
  return diffMs >= 0 ? `in ${label}` : `${label} overdue`;
}
