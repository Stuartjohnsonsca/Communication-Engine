/**
 * Post-PRD hardening item 68 — CSV export of the draft outcome rollup
 * (FCG-window adherence, send rate, bypass rate, per-source +
 * per-Member breakdowns).
 *
 * Same posture as the audit-log CSV exporter (item 49):
 *   - RFC 4180 line endings (CRLF) + trailing terminator
 *   - UTF-8 BOM prefix so Excel opens it correctly on Windows
 *   - Pure function in its own module so the route handler and the
 *     test can both import it without spinning up NextAuth
 *
 * Shape: one wide table where every row carries the same column set
 * regardless of scope. The `scope` column discriminates totals /
 * per-source / per-member, and `label` is the human-readable name
 * (e.g. "Totals", "Channel-ingested", "<member email>"). Compliance
 * reviewers who pivot the file in a spreadsheet can filter by `scope`
 * without parsing nested sections.
 */

import type { DraftRollup } from "./rollup";

export const UTF8_BOM = "﻿";

export const DRAFTS_ROLLUP_CSV_HEADER = [
  "scope",
  "label",
  "produced",
  "sent",
  "discarded",
  "open",
  "sendRate",
  "bypassRate",
  "withinWindowRate",
  "sentWithDeadline",
  "sentWithinWindow",
  "sentAfterWindow",
  "openOverdue",
] as const;

const SOURCE_LABEL: Record<keyof DraftRollup["bySource"], string> = {
  ingested: "Channel-ingested",
  manual_paste: "Manual paste",
  bypassed_synth: "Bypassed (post-hoc synth)",
};

/**
 * Render the rollup as RFC 4180 CSV. Membership labels are resolved
 * by the caller — pass `memberLabels` mapping membershipId → display
 * name (typically user.name or user.email).
 *
 * Source rows always emit blank `bypassRate` and blank FCG-window
 * fields: bypass-rate only makes sense at the firm aggregate, and
 * FCG-window per source row is computed on the same exclusions as
 * the firm-wide block, so re-publishing it per source would double-
 * count. Member rows emit blank `bypassRate` for the same reason —
 * we don't track per-Member bypass-rate today (would require a
 * separate per-Member denominator); the column stays present so the
 * shape is consistent across rows.
 */
export function formatDraftsRollupAsCsv(
  rollup: DraftRollup,
  memberLabels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [DRAFTS_ROLLUP_CSV_HEADER.join(",")];

  // Totals row — first non-header line so spreadsheet readers see the
  // firm aggregate at the top.
  lines.push(
    csvRow({
      scope: "totals",
      label: `Totals (${rollup.windowDays}d)`,
      produced: rollup.totals.produced,
      sent: rollup.totals.sent,
      discarded: rollup.totals.discarded,
      open: rollup.totals.open,
      sendRate: rollup.sendRate,
      bypassRate: rollup.bypassRate,
      withinWindowRate: rollup.fcgWindow.withinWindowRate,
      sentWithDeadline: rollup.fcgWindow.sentWithDeadline,
      sentWithinWindow: rollup.fcgWindow.sentWithinWindow,
      sentAfterWindow: rollup.fcgWindow.sentAfterWindow,
      openOverdue: rollup.fcgWindow.openOverdue,
    }),
  );

  for (const key of Object.keys(rollup.bySource) as Array<keyof DraftRollup["bySource"]>) {
    const b = rollup.bySource[key];
    const terminal = b.produced - b.open;
    const sendRate = terminal > 0 ? b.sent / terminal : null;
    lines.push(
      csvRow({
        scope: `source:${key}`,
        label: SOURCE_LABEL[key],
        produced: b.produced,
        sent: b.sent,
        discarded: b.discarded,
        open: b.open,
        sendRate,
        bypassRate: null,
        withinWindowRate: null,
        sentWithDeadline: null,
        sentWithinWindow: null,
        sentAfterWindow: null,
        openOverdue: null,
      }),
    );
  }

  for (const m of rollup.byMembership) {
    const terminal = m.produced - m.open;
    const sendRate = terminal > 0 ? m.sent / terminal : null;
    lines.push(
      csvRow({
        scope: `member:${m.membershipId}`,
        label: memberLabels.get(m.membershipId) ?? m.membershipId,
        produced: m.produced,
        sent: m.sent,
        discarded: m.discarded,
        open: m.open,
        sendRate,
        bypassRate: null,
        withinWindowRate: m.fcgWindow.withinWindowRate,
        sentWithDeadline: m.fcgWindow.sentWithDeadline,
        sentWithinWindow: m.fcgWindow.sentWithinWindow,
        sentAfterWindow: m.fcgWindow.sentAfterWindow,
        openOverdue: m.fcgWindow.openOverdue,
      }),
    );
  }

  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

type Row = {
  scope: string;
  label: string;
  produced: number;
  sent: number;
  discarded: number;
  open: number;
  sendRate: number | null;
  bypassRate: number | null;
  withinWindowRate: number | null;
  sentWithDeadline: number | null;
  sentWithinWindow: number | null;
  sentAfterWindow: number | null;
  openOverdue: number | null;
};

function csvRow(r: Row): string {
  return [
    r.scope,
    r.label,
    r.produced.toString(),
    r.sent.toString(),
    r.discarded.toString(),
    r.open.toString(),
    rate(r.sendRate),
    rate(r.bypassRate),
    rate(r.withinWindowRate),
    nullable(r.sentWithDeadline),
    nullable(r.sentWithinWindow),
    nullable(r.sentAfterWindow),
    nullable(r.openOverdue),
  ]
    .map(csvField)
    .join(",");
}

/**
 * Rates render as "0.5000" (4dp) when present, blank when null.
 * Spreadsheets parse the blank as a missing value rather than 0 — load-
 * bearing so the totals row's null `bypassRate` (when no sends yet)
 * doesn't get charted as 0%.
 */
function rate(v: number | null): string {
  return v === null ? "" : v.toFixed(4);
}

function nullable(v: number | null): string {
  return v === null ? "" : v.toString();
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  if (!CSV_NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
