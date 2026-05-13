/**
 * Post-PRD hardening item 89 — uncapped per-escalation CSV export of
 * adherence escalations (acknowledged + open-overdue) in a window.
 *
 * Sister to item 83's `sentiment-responses-export.ts` on the adherence
 * pillar. The /adherence/escalations page lists the latest 200 rows for
 * triage; for a monthly compliance review a FIRM_ADMIN needs the full
 * per-escalation record. Same shape, same RBAC posture
 * (FIRM_ADMIN + FCT_MEMBER), same audit-on-export pattern, same RFC
 * 4180 + UTF-8 BOM + CRLF output.
 *
 * Why a separate module instead of extending an adherence rollup:
 *   - There IS no adherence rollup analog of `computeDraftRollup` /
 *     `computeSentimentMetrics` today. If a future item adds one, this
 *     exporter stays separate — same rule applied at items 69 / 76 / 83:
 *     row-level CSV output is a different shape than an aggregate, and
 *     putting raw rows on the rollup contract balloons every page render.
 *   - Two narrow queries (one for acknowledged-in-window, one for
 *     open-overdue) keep SQL predicates aligned exactly with bucket
 *     semantics — bytes we'd only drop in-app aren't fetched.
 *
 * Bucket semantics:
 *   - `acknowledged` — `escalatedAt` in window AND `acknowledgedAt` set.
 *     Carries `ackMs = acknowledgedAt - escalatedAt`.
 *   - `openOverdue` — `escalatedAt` in window AND `acknowledgedAt` null.
 *     Carries `outstandingMs = now - escalatedAt`.
 *
 * Window scope: `escalatedAt` is the cut-off. A row that pre-dates the
 * window doesn't appear even if it's still open (a 90d-old unacked
 * escalation isn't this window's evidence). Non-escalated adherence
 * rows (`escalatedAt === null`) NEVER appear — they're scored-but-OK
 * sends and aren't a response-time concern.
 *
 * Output mirrors item 83's shape (per-row id, classification proxy via
 * `overall` score, escalated-at, acked-at, who-acked, sender member,
 * draft id + channel, FCG/UCG versions). Two duration columns
 * (`ackMs` + `outstandingMs`) so spreadsheets can sort and the
 * `durationLabel` column is the human-readable mirror via
 * `@/lib/format/duration` (item 87 — the shared formatter that now
 * underpins every per-row CSV).
 */

import { superDb } from "@/lib/db";
import { formatDuration } from "@/lib/format/duration";

export type AdherenceExportWindow = 7 | 30 | 90;

export const UTF8_BOM = "﻿";

export const ADHERENCE_ESCALATIONS_CSV_HEADER = [
  "bucket",
  "adherenceId",
  "draftId",
  "channel",
  "subject",
  "synthesisedFromOutboundIngest",
  "inboundSender",
  "fcgVersionUsed",
  "ucgVersionUsed",
  "overall",
  "overallPct",
  "membershipId",
  "memberLabel",
  "escalatedAt",
  "acknowledgedAt",
  "acknowledgedByMembershipId",
  "ackedByLabel",
  "ackMs",
  "outstandingMs",
  "durationLabel",
] as const;

/**
 * Defensive cap. Adherence escalations fire whenever an observed send
 * scores below threshold — volumes can spike during a regression but
 * 50k per bucket is still ample for a 90d window at typical tenant
 * scale. Matches items 66 / 76 / 83.
 */
const MAX_ROWS = 50_000;

export type AdherenceEscalationAckRow = {
  adherenceId: string;
  draftId: string;
  channel: string;
  subject: string | null;
  synthesisedFromOutboundIngest: boolean;
  inboundSender: string | null;
  fcgVersionUsed: number;
  ucgVersionUsed: number | null;
  overall: number;
  membershipId: string;
  escalatedAt: Date;
  acknowledgedAt: Date;
  acknowledgedByMembershipId: string | null;
  ackMs: number;
};

export type AdherenceEscalationOpenRow = {
  adherenceId: string;
  draftId: string;
  channel: string;
  subject: string | null;
  synthesisedFromOutboundIngest: boolean;
  inboundSender: string | null;
  fcgVersionUsed: number;
  ucgVersionUsed: number | null;
  overall: number;
  membershipId: string;
  escalatedAt: Date;
  outstandingMs: number;
};

export type AdherenceEscalationsExport = {
  windowDays: number;
  acknowledged: AdherenceEscalationAckRow[];
  openOverdue: AdherenceEscalationOpenRow[];
};

export async function getAllAdherenceEscalations(input: {
  tenantId: string;
  windowDays?: AdherenceExportWindow;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
}): Promise<AdherenceEscalationsExport> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Two parallel narrow queries. Both filter `escalatedAt` to the
  // window AND `not null` at the SQL layer — non-escalated rows don't
  // count and we don't pay to fetch them.
  const [ackedRows, openRows] = await Promise.all([
    superDb.communicationAdherence.findMany({
      where: {
        tenantId: input.tenantId,
        escalatedAt: { not: null, gte: since, lt: now },
        acknowledgedAt: { not: null },
      },
      select: {
        id: true,
        draftId: true,
        membershipId: true,
        overall: true,
        fcgVersionUsed: true,
        ucgVersionUsed: true,
        escalatedAt: true,
        acknowledgedAt: true,
        acknowledgedById: true,
        draft: {
          select: {
            channel: true,
            subject: true,
            synthesisedFromOutboundIngest: true,
            inboundSender: true,
          },
        },
      },
      take: MAX_ROWS,
    }),
    superDb.communicationAdherence.findMany({
      where: {
        tenantId: input.tenantId,
        escalatedAt: { not: null, gte: since, lt: now },
        acknowledgedAt: null,
      },
      select: {
        id: true,
        draftId: true,
        membershipId: true,
        overall: true,
        fcgVersionUsed: true,
        ucgVersionUsed: true,
        escalatedAt: true,
        draft: {
          select: {
            channel: true,
            subject: true,
            synthesisedFromOutboundIngest: true,
            inboundSender: true,
          },
        },
      },
      take: MAX_ROWS,
    }),
  ]);

  const acknowledged: AdherenceEscalationAckRow[] = [];
  for (const r of ackedRows) {
    if (!r.escalatedAt || !r.acknowledgedAt) continue;
    const ackMs = Math.max(
      0,
      r.acknowledgedAt.getTime() - r.escalatedAt.getTime(),
    );
    acknowledged.push({
      adherenceId: r.id,
      draftId: r.draftId,
      channel: r.draft.channel,
      subject: r.draft.subject,
      synthesisedFromOutboundIngest: r.draft.synthesisedFromOutboundIngest,
      inboundSender: r.draft.inboundSender,
      fcgVersionUsed: r.fcgVersionUsed,
      ucgVersionUsed: r.ucgVersionUsed,
      overall: r.overall,
      membershipId: r.membershipId,
      escalatedAt: r.escalatedAt,
      acknowledgedAt: r.acknowledgedAt,
      acknowledgedByMembershipId: r.acknowledgedById,
      ackMs,
    });
  }

  const openOverdue: AdherenceEscalationOpenRow[] = [];
  for (const r of openRows) {
    if (!r.escalatedAt) continue;
    const outstandingMs = Math.max(0, now.getTime() - r.escalatedAt.getTime());
    openOverdue.push({
      adherenceId: r.id,
      draftId: r.draftId,
      channel: r.draft.channel,
      subject: r.draft.subject,
      synthesisedFromOutboundIngest: r.draft.synthesisedFromOutboundIngest,
      inboundSender: r.draft.inboundSender,
      fcgVersionUsed: r.fcgVersionUsed,
      ucgVersionUsed: r.ucgVersionUsed,
      overall: r.overall,
      membershipId: r.membershipId,
      escalatedAt: r.escalatedAt,
      outstandingMs,
    });
  }

  // Slowest-first within each bucket — operator priority for a monthly
  // compliance review is "longest response wins" (acked bucket) and
  // "longest outstanding wins" (open bucket). Tie-break by
  // `escalatedAt` ascending so identical-duration rows have a stable,
  // oldest-first order across re-runs on the same data. Same shape as
  // item 83's sentiment-side export.
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

export function formatAdherenceEscalationsAsCsv(
  responses: AdherenceEscalationsExport,
  memberLabels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [ADHERENCE_ESCALATIONS_CSV_HEADER.join(",")];
  for (const r of responses.acknowledged) {
    lines.push(ackRow(r, memberLabels));
  }
  for (const r of responses.openOverdue) {
    lines.push(openRow(r, memberLabels));
  }
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

function ackRow(
  r: AdherenceEscalationAckRow,
  memberLabels: Map<string, string>,
): string {
  const memberLabel = memberLabels.get(r.membershipId) ?? r.membershipId;
  const ackedLabel =
    (r.acknowledgedByMembershipId &&
      memberLabels.get(r.acknowledgedByMembershipId)) ??
    r.acknowledgedByMembershipId ??
    "";
  return [
    "acknowledged",
    r.adherenceId,
    r.draftId,
    r.channel,
    r.subject ?? "",
    r.synthesisedFromOutboundIngest ? "true" : "false",
    r.inboundSender ?? "",
    r.fcgVersionUsed.toString(),
    r.ucgVersionUsed != null ? r.ucgVersionUsed.toString() : "",
    r.overall.toFixed(4),
    Math.round(r.overall * 100).toString(),
    r.membershipId,
    memberLabel,
    r.escalatedAt.toISOString(),
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
  r: AdherenceEscalationOpenRow,
  memberLabels: Map<string, string>,
): string {
  const memberLabel = memberLabels.get(r.membershipId) ?? r.membershipId;
  return [
    "open_overdue",
    r.adherenceId,
    r.draftId,
    r.channel,
    r.subject ?? "",
    r.synthesisedFromOutboundIngest ? "true" : "false",
    r.inboundSender ?? "",
    r.fcgVersionUsed.toString(),
    r.ucgVersionUsed != null ? r.ucgVersionUsed.toString() : "",
    r.overall.toFixed(4),
    Math.round(r.overall * 100).toString(),
    r.membershipId,
    memberLabel,
    r.escalatedAt.toISOString(),
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
