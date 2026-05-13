/**
 * Post-PRD hardening item 83 — uncapped per-signal CSV export of
 * sentiment responses (acknowledged + open-overdue escalations).
 *
 * The /sentiment page from item 78 onward surfaces the response-time
 * card + filter chips + a list capped at 200 rows. For a monthly
 * compliance review or a partner conversation a FIRM_ADMIN needs the
 * full per-signal record of every escalation in the window, not just
 * the first page-full. This module is the uncapped export path —
 * sister to `getAllFcgMisses` (item 76) on the sentiment side.
 *
 * Why a separate module instead of extending `computeSentimentMetrics`
 * (item 78):
 *   - `computeSentimentMetrics` already aggregates inside its scan to
 *     return medians + counts. Returning every row from there would
 *     change its contract and balloon every /sentiment page render +
 *     every cron tick that consumes the metrics.
 *   - The export needs row-level detail (signal id, classification,
 *     escalated-at, acknowledged-at, who acked it) which the metrics
 *     shape deliberately doesn't carry — a row-level CSV with full
 *     ack metadata is a different output type.
 *   - Two narrow queries (one for acknowledged-in-window, one for
 *     open-overdue) keep SQL predicates aligned exactly with bucket
 *     semantics — same "bytes we'd only drop in-app aren't fetched"
 *     rule as items 69 / 76.
 *
 * Bucket semantics mirror the sentiment metrics card (item 78):
 *   - `acknowledged` — `escalatedAt` in window AND `acknowledgedAt`
 *     set. Carries `ackMs = acknowledgedAt - escalatedAt`.
 *   - `openOverdue` — `escalatedAt` in window AND `acknowledgedAt`
 *     null. Carries `outstandingMs = now - escalatedAt`.
 *
 * Same window semantics as `computeSentimentMetrics`: `escalatedAt`
 * is the cut-off (signals NOT yet escalated don't count — they're a
 * classifier signal, not a response-time signal). Defaults to 30d
 * matching item 78's headline window.
 *
 * Output format mirrors item 76's misses-export: RFC 4180 + CRLF +
 * trailing terminator + UTF-8 BOM so Excel on Windows opens it
 * correctly. Same `csvField` quoting rules.
 */

import { superDb } from "@/lib/db";
import { formatDuration } from "@/lib/format/duration";
import type { SentimentMetricsWindow } from "./metrics";

export const UTF8_BOM = "﻿";

export const SENTIMENT_RESPONSES_CSV_HEADER = [
  "bucket",
  "signalId",
  "classification",
  "escalatedAt",
  "assignedToMembershipId",
  "memberLabel",
  "acknowledgedAt",
  "acknowledgedByMembershipId",
  "ackedByLabel",
  "ackMs",
  "outstandingMs",
  "durationLabel",
] as const;

/**
 * Defensive cap. Sentiment volumes are tens-to-hundreds per tenant per
 * month (item 78); 50k is generous for a 90d export and matches the
 * cap pattern from items 66 / 76.
 */
const MAX_ROWS = 50_000;

export type SentimentResponseAckRow = {
  signalId: string;
  classification: string;
  escalatedAt: Date;
  acknowledgedAt: Date;
  assignedToMembershipId: string | null;
  acknowledgedByMembershipId: string | null;
  ackMs: number;
};

export type SentimentResponseOpenRow = {
  signalId: string;
  classification: string;
  escalatedAt: Date;
  assignedToMembershipId: string | null;
  outstandingMs: number;
};

export type SentimentResponsesExport = {
  windowDays: number;
  acknowledged: SentimentResponseAckRow[];
  openOverdue: SentimentResponseOpenRow[];
};

export async function getAllSentimentResponses(input: {
  tenantId: string;
  windowDays?: SentimentMetricsWindow;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
}): Promise<SentimentResponsesExport> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Two parallel narrow queries. The acked side filters
  // `acknowledgedAt: { not: null }` AND `escalatedAt` in window — Prisma
  // can express both in the WHERE clause so we don't fetch open rows
  // only to drop them. The open side mirrors with `acknowledgedAt:
  // null`, scoped to the same window predicate.
  const [ackedRows, openRows] = await Promise.all([
    superDb.sentimentSignal.findMany({
      where: {
        tenantId: input.tenantId,
        escalatedAt: { not: null, gte: since, lt: now },
        acknowledgedAt: { not: null },
      },
      select: {
        id: true,
        classification: true,
        escalatedAt: true,
        acknowledgedAt: true,
        assignedToMembershipId: true,
        acknowledgedById: true,
      },
      take: MAX_ROWS,
    }),
    superDb.sentimentSignal.findMany({
      where: {
        tenantId: input.tenantId,
        escalatedAt: { not: null, gte: since, lt: now },
        acknowledgedAt: null,
      },
      select: {
        id: true,
        classification: true,
        escalatedAt: true,
        assignedToMembershipId: true,
      },
      take: MAX_ROWS,
    }),
  ]);

  const acknowledged: SentimentResponseAckRow[] = [];
  for (const r of ackedRows) {
    if (!r.escalatedAt || !r.acknowledgedAt) continue;
    const ackMs = Math.max(
      0,
      r.acknowledgedAt.getTime() - r.escalatedAt.getTime(),
    );
    acknowledged.push({
      signalId: r.id,
      classification: r.classification,
      escalatedAt: r.escalatedAt,
      acknowledgedAt: r.acknowledgedAt,
      assignedToMembershipId: r.assignedToMembershipId,
      acknowledgedByMembershipId: r.acknowledgedById,
      ackMs,
    });
  }

  const openOverdue: SentimentResponseOpenRow[] = [];
  for (const r of openRows) {
    if (!r.escalatedAt) continue;
    const outstandingMs = Math.max(0, now.getTime() - r.escalatedAt.getTime());
    openOverdue.push({
      signalId: r.id,
      classification: r.classification,
      escalatedAt: r.escalatedAt,
      assignedToMembershipId: r.assignedToMembershipId,
      outstandingMs,
    });
  }

  // Slowest-first within each bucket — operator priority is "longest
  // response time" (acked bucket) and "longest outstanding" (open
  // bucket). Tie-break by `escalatedAt` ascending so identical-duration
  // rows have a stable, oldest-first order.
  acknowledged.sort((a, b) => {
    if (b.ackMs !== a.ackMs) return b.ackMs - a.ackMs;
    return a.escalatedAt.getTime() - b.escalatedAt.getTime();
  });
  openOverdue.sort((a, b) => {
    if (b.outstandingMs !== a.outstandingMs) {
      return b.outstandingMs - a.outstandingMs;
    }
    return a.escalatedAt.getTime() - b.escalatedAt.getTime();
  });

  return { windowDays, acknowledged, openOverdue };
}

export function formatSentimentResponsesAsCsv(
  responses: SentimentResponsesExport,
  memberLabels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [SENTIMENT_RESPONSES_CSV_HEADER.join(",")];
  for (const r of responses.acknowledged) {
    lines.push(ackRow(r, memberLabels));
  }
  for (const r of responses.openOverdue) {
    lines.push(openRow(r, memberLabels));
  }
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

function ackRow(
  r: SentimentResponseAckRow,
  memberLabels: Map<string, string>,
): string {
  const assignedLabel =
    (r.assignedToMembershipId &&
      memberLabels.get(r.assignedToMembershipId)) ??
    r.assignedToMembershipId ??
    "";
  const ackedLabel =
    (r.acknowledgedByMembershipId &&
      memberLabels.get(r.acknowledgedByMembershipId)) ??
    r.acknowledgedByMembershipId ??
    "";
  return [
    "acknowledged",
    r.signalId,
    r.classification,
    r.escalatedAt.toISOString(),
    r.assignedToMembershipId ?? "",
    assignedLabel,
    r.acknowledgedAt.toISOString(),
    r.acknowledgedByMembershipId ?? "",
    ackedLabel,
    r.ackMs.toString(),
    "",
    formatDuration(r.ackMs),
  ]
    .map(csvField)
    .join(",");
}

function openRow(
  r: SentimentResponseOpenRow,
  memberLabels: Map<string, string>,
): string {
  const assignedLabel =
    (r.assignedToMembershipId &&
      memberLabels.get(r.assignedToMembershipId)) ??
    r.assignedToMembershipId ??
    "";
  return [
    "open_overdue",
    r.signalId,
    r.classification,
    r.escalatedAt.toISOString(),
    r.assignedToMembershipId ?? "",
    assignedLabel,
    "",
    "",
    "",
    "",
    r.outstandingMs.toString(),
    formatDuration(r.outstandingMs),
  ]
    .map(csvField)
    .join(",");
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  if (!CSV_NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
