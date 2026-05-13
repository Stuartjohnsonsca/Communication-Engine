/**
 * Post-PRD hardening item 76 — uncapped CSV export of FCG-window
 * misses (sent-after + open-overdue).
 *
 * The /admin/drafts misses panel from item 74 surfaces the top
 * `RECENT_MISSES_LIMIT` (10) of each bucket as an at-a-glance triage
 * list. For a monthly compliance review or partner conversation a
 * FIRM_ADMIN needs every miss in the window, not just the worst ten.
 * This module is the uncapped export path.
 *
 * Why a separate module instead of extending the rollup:
 *   - `computeDraftRollup` already builds the capped top-10 list in
 *     its existing scan (item 74). Removing the cap there would balloon
 *     every page load + every cron tick that consumes the rollup.
 *   - The export needs the full row set sorted by lateness, which is
 *     a different output shape than the rollup carries today. Keeping
 *     it in its own module avoids coupling the CSV exporter to a
 *     wider rollup output type.
 *   - Two narrow queries (one for sent-after, one for open-overdue)
 *     are clearer than one big query that filters in-app — the SQL
 *     predicates match the exclusions exactly, mirroring item 69's
 *     "bytes we'd only drop in-app aren't fetched" rule.
 *
 * Same exclusions as items 66 / 74:
 *   - bypassed-synth drafts NEVER appear (no engine promise applied)
 *   - drafts without `fcgWindowDeadline` NEVER appear (no promise to
 *     keep)
 *   - DISCARDED past-deadline drafts NEVER appear in openOverdue
 *     (operator-marked-out-of-scope is not a broken promise)
 *
 * Output format mirrors item 49's audit-CSV / item 68's drafts-rollup
 * CSV: RFC 4180 + CRLF + trailing terminator + UTF-8 BOM so Excel on
 * Windows opens it correctly.
 */

import { superDb } from "@/lib/db";
import { formatDuration } from "@/lib/format/duration";
import type { DraftRollupWindow, FcgMissRow } from "./rollup";

export const UTF8_BOM = "﻿";

export const FCG_MISSES_CSV_HEADER = [
  "bucket",
  "draftId",
  "membershipId",
  "memberLabel",
  "status",
  "fcgWindowDeadline",
  "sentMarkedAt",
  "lateMs",
  "lateBy",
] as const;

/// Hard cap for defensive sanity. A 90d window with thousands of misses
/// in a single tenant signals something's gone very wrong; 50k is the
/// same cap `computeDraftRollup` uses.
const MAX_ROWS = 50_000;

export type FcgMissesExport = {
  windowDays: number;
  sentAfterWindow: FcgMissRow[];
  openOverdue: FcgMissRow[];
};

export async function getAllFcgMisses(input: {
  tenantId: string;
  windowDays?: DraftRollupWindow;
}): Promise<FcgMissesExport> {
  const windowDays = input.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Two parallel narrow queries — SQL exclusions match items 66/74.
  // The sent-after side can't filter `sentMarkedAt > fcgWindowDeadline`
  // in SQL via Prisma (no field-vs-field comparator), so we fetch all
  // SENT-with-deadline rows in the window and filter in-app. Open-
  // overdue side can express the full predicate in SQL.
  const [sentRows, openRows] = await Promise.all([
    superDb.draft.findMany({
      where: {
        tenantId: input.tenantId,
        createdAt: { gte: since },
        synthesisedFromOutboundIngest: false,
        fcgWindowDeadline: { not: null },
        status: "SENT",
      },
      select: {
        id: true,
        membershipId: true,
        fcgWindowDeadline: true,
        sentMarkedAt: true,
        status: true,
      },
      take: MAX_ROWS,
    }),
    superDb.draft.findMany({
      where: {
        tenantId: input.tenantId,
        createdAt: { gte: since },
        synthesisedFromOutboundIngest: false,
        fcgWindowDeadline: { lt: now, not: null },
        status: { in: ["PROPOSED", "EDITED", "ACCEPTED"] },
      },
      select: {
        id: true,
        membershipId: true,
        fcgWindowDeadline: true,
        sentMarkedAt: true,
        status: true,
      },
      take: MAX_ROWS,
    }),
  ]);

  const sentAfterWindow: FcgMissRow[] = [];
  for (const r of sentRows) {
    if (!r.fcgWindowDeadline || !r.sentMarkedAt) continue;
    const lateMs = r.sentMarkedAt.getTime() - r.fcgWindowDeadline.getTime();
    if (lateMs <= 0) continue;
    sentAfterWindow.push({
      draftId: r.id,
      membershipId: r.membershipId,
      fcgWindowDeadline: r.fcgWindowDeadline,
      sentMarkedAt: r.sentMarkedAt,
      // Narrowed: SENT is the only status the query returns.
      status: r.status as "SENT",
      lateMs,
    });
  }

  const openOverdue: FcgMissRow[] = [];
  for (const r of openRows) {
    if (!r.fcgWindowDeadline) continue;
    openOverdue.push({
      draftId: r.id,
      membershipId: r.membershipId,
      fcgWindowDeadline: r.fcgWindowDeadline,
      sentMarkedAt: r.sentMarkedAt,
      // Narrowed: the `in` filter already excludes SENT + DISCARDED.
      status: r.status as Exclude<typeof r.status, "SENT" | "DISCARDED">,
      lateMs: now.getTime() - r.fcgWindowDeadline.getTime(),
    });
  }

  // Most-late first within each bucket (operator priority is "worst
  // miss right now"). Tie-break by deadline asc so identical-lateness
  // rows have a stable order.
  const sortByLateness = (a: FcgMissRow, b: FcgMissRow) => {
    if (b.lateMs !== a.lateMs) return b.lateMs - a.lateMs;
    return a.fcgWindowDeadline.getTime() - b.fcgWindowDeadline.getTime();
  };
  sentAfterWindow.sort(sortByLateness);
  openOverdue.sort(sortByLateness);

  return { windowDays, sentAfterWindow, openOverdue };
}

export function formatFcgMissesAsCsv(
  misses: FcgMissesExport,
  memberLabels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [FCG_MISSES_CSV_HEADER.join(",")];
  for (const r of misses.sentAfterWindow) {
    lines.push(csvRow("sent_after", r, memberLabels));
  }
  for (const r of misses.openOverdue) {
    lines.push(csvRow("open_overdue", r, memberLabels));
  }
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

function csvRow(
  bucket: "sent_after" | "open_overdue",
  r: FcgMissRow,
  memberLabels: Map<string, string>,
): string {
  const label =
    (r.membershipId && memberLabels.get(r.membershipId)) ?? r.membershipId ?? "";
  return [
    bucket,
    r.draftId,
    r.membershipId ?? "",
    label,
    r.status,
    r.fcgWindowDeadline.toISOString(),
    r.sentMarkedAt ? r.sentMarkedAt.toISOString() : "",
    r.lateMs.toString(),
    formatDuration(r.lateMs),
  ]
    .map(csvField)
    .join(",");
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  if (!CSV_NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
