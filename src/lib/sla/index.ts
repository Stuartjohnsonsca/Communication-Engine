import { Prisma, type SlaKind, type SlaMeasurement, type SlaOutcome, type SlaTarget } from "@prisma/client";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §13.1 Service Levels.
 *
 * The catalogue is global (`SlaTarget`). Each Client gets per-month
 * `SlaMeasurement` rows that are tenant-scoped + RLS-protected. The page
 * at `/sla` shows targets + this tenant's last 12 months of measurements.
 *
 * Latency targets can be auto-measured from `ModelRun` (we already log
 * `purpose` + `latencyMs` for every drafting / judge / sentiment / agent
 * run). Availability is operator-input from external uptime monitoring.
 *
 * `recordOrComputeMeasurement` is the entry point used by the operator
 * console + by the cron sweep at month-end.
 */

const ACUMON_TENANT_SLUG = "acumon";

export function isAcumonSlaOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}

export type TargetWithMeasurements = SlaTarget & {
  measurements: SlaMeasurement[];
};

export async function getSlaView(tenantId: string, periods = 12): Promise<{
  targets: TargetWithMeasurements[];
  periodCodes: string[];
  latestMissed: number;
}> {
  const targets = await superDb.slaTarget.findMany({
    where: { isActive: true },
    orderBy: { ordinal: "asc" },
  });
  const periodCodes = lastNPeriods(periods);
  const measurements = await tenantDb(tenantId).slaMeasurement.findMany({
    where: { tenantId, period: { in: periodCodes } },
    orderBy: { period: "desc" },
  });

  const byTarget = new Map<string, SlaMeasurement[]>();
  for (const m of measurements) {
    const list = byTarget.get(m.targetId) ?? [];
    list.push(m);
    byTarget.set(m.targetId, list);
  }

  const decorated = targets.map((t) => ({
    ...t,
    measurements: byTarget.get(t.id) ?? [],
  }));

  // "Missed in latest period" — the most recent period that has any
  // measurement at all.
  const latestPeriod = measurements[0]?.period;
  const latestMissed = latestPeriod
    ? measurements.filter((m) => m.period === latestPeriod && m.outcome === "MISSED").length
    : 0;

  return { targets: decorated, periodCodes, latestMissed };
}

function lastNPeriods(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ─── Recording measurements ───────────────────────────────────────────────

export type RecordMeasurementInput = {
  tenantId: string;
  targetCode: string;
  period: string;
  observed: number | null;
  sampleN: number;
  payload?: Prisma.InputJsonValue | null;
  note?: string | null;
  recordedByName: string;
  actorMembershipId: string;
};

export async function recordSlaMeasurement(
  input: RecordMeasurementInput,
): Promise<SlaMeasurement> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new Error("sla: period must be YYYY-MM");
  }
  if (!input.recordedByName.trim()) throw new Error("sla: recordedByName required");

  const target = await superDb.slaTarget.findUnique({ where: { code: input.targetCode } });
  if (!target) throw new Error(`sla: target ${input.targetCode} not found`);

  const outcome: SlaOutcome =
    input.observed === null
      ? "INSUFFICIENT_DATA"
      : compareToTarget(target, input.observed)
        ? "MET"
        : "MISSED";

  const data = {
    tenantId: input.tenantId,
    targetId: target.id,
    period: input.period,
    observed: input.observed,
    outcome,
    sampleN: input.sampleN,
    payload: input.payload ?? Prisma.DbNull,
    note: input.note?.trim() || null,
    recordedAt: new Date(),
    recordedByName: input.recordedByName.trim(),
  };

  const upserted = await tenantDb(input.tenantId).slaMeasurement.upsert({
    where: {
      tenantId_targetId_period: {
        tenantId: input.tenantId,
        targetId: target.id,
        period: input.period,
      },
    },
    create: data,
    update: {
      observed: data.observed,
      outcome,
      sampleN: data.sampleN,
      payload: data.payload,
      note: data.note,
      recordedAt: data.recordedAt,
      recordedByName: data.recordedByName,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "SLA_MEASUREMENT_RECORDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SlaMeasurement",
    subjectId: upserted.id,
    payload: {
      targetCode: input.targetCode,
      period: input.period,
      observed: input.observed,
      outcome,
      sampleN: input.sampleN,
    },
  });

  return upserted;
}

function compareToTarget(target: SlaTarget, observed: number): boolean {
  if (target.kind === "AVAILABILITY") {
    // Higher is better.
    return observed >= target.threshold;
  }
  // LATENCY — lower is better.
  return observed <= target.threshold;
}

// ─── Auto-compute latency from ModelRun ───────────────────────────────────

const PURPOSE_TO_TARGET_CODES: Record<string, string> = {
  // PRD §13.1 — short = EMAIL/ACTION_ONLY drafts; technical = TECHNICAL drafts.
  "draft.short": "drafting-latency-short",
  "draft.email": "drafting-latency-short",
  "draft.action": "drafting-latency-short",
  "draft.technical": "drafting-latency-technical",
  "judge.ucg": "compliance-judge-latency",
  "judge": "compliance-judge-latency",
  "voice.transcribe": "voice-transcription-latency",
};

/**
 * Auto-compute latency-flavoured measurements for one tenant for the given
 * period from ModelRun. Returns the targets that produced a measurement.
 * Operator can then either accept or override with `recordSlaMeasurement`.
 */
export async function computeLatencyMeasurements(
  tenantId: string,
  period: string,
  recordedByName: string,
  actorMembershipId: string,
): Promise<{ recorded: number; insufficient: number }> {
  const [year, month] = period.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const runs = await superDb.modelRun.findMany({
    where: {
      tenantId,
      createdAt: { gte: from, lt: to },
      latencyMs: { not: null },
    },
    select: { purpose: true, latencyMs: true },
  });

  const grouped = new Map<string, number[]>();
  for (const r of runs) {
    const code = PURPOSE_TO_TARGET_CODES[r.purpose];
    if (!code || r.latencyMs == null) continue;
    const bucket = grouped.get(code) ?? [];
    bucket.push(r.latencyMs);
    grouped.set(code, bucket);
  }

  let recorded = 0;
  let insufficient = 0;

  const codes = Object.values(PURPOSE_TO_TARGET_CODES);
  const uniqueCodes = Array.from(new Set(codes));
  for (const targetCode of uniqueCodes) {
    const bucket = grouped.get(targetCode) ?? [];
    if (bucket.length < 5) {
      // Per PRD §13.1 we want a meaningful median, not a one-off. Below 5
      // samples the determination is recorded as INSUFFICIENT_DATA.
      await recordSlaMeasurement({
        tenantId,
        targetCode,
        period,
        observed: null,
        sampleN: bucket.length,
        recordedByName,
        actorMembershipId,
      });
      insufficient += 1;
      continue;
    }

    bucket.sort((a, b) => a - b);
    const mid = Math.floor(bucket.length / 2);
    const medianMs =
      bucket.length % 2 === 0 ? (bucket[mid - 1] + bucket[mid]) / 2 : bucket[mid];
    const max = bucket[bucket.length - 1];
    const p95 = bucket[Math.floor(bucket.length * 0.95)] ?? max;
    const observedSeconds = medianMs / 1000;

    await recordSlaMeasurement({
      tenantId,
      targetCode,
      period,
      observed: observedSeconds,
      sampleN: bucket.length,
      payload: { medianMs, p95Ms: p95, maxMs: max },
      recordedByName,
      actorMembershipId,
    });
    recorded += 1;
  }

  return { recorded, insufficient };
}

// ─── Adherence KPI rollup (§13.3) ─────────────────────────────────────────

export type AdherenceKpis = {
  responseTimeAdherencePct: number | null;
  toneAdherenceAvg: number | null;
  draftAcceptanceRatePct: number | null;
  salesIdConversionPct: number | null;
  sampleN: number;
};

export async function getAdherenceKpis(tenantId: string, period: string): Promise<AdherenceKpis> {
  const [year, month] = period.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const adherence = await tenantDb(tenantId).communicationAdherence.findMany({
    where: { tenantId, createdAt: { gte: from, lt: to } },
    select: { perDimension: true, overall: true },
  });

  const drafts = await tenantDb(tenantId).draft.findMany({
    where: {
      tenantId,
      sentMarkedAt: { gte: from, lt: to, not: null },
    },
    select: { sentText: true, body: true },
  });

  const opportunities = await tenantDb(tenantId).opportunityCandidate.findMany({
    where: { tenantId, createdAt: { gte: from, lt: to } },
    select: { status: true },
  });

  const sampleN = adherence.length;

  const responseTimeAdherencePct = sampleN
    ? Math.round(
        (adherence.filter((a) => extractDimension(a.perDimension, "responseTime")?.verdict === "PASS").length /
          sampleN) *
          100,
      )
    : null;
  const toneScores = adherence
    .map((a) => extractDimension(a.perDimension, "tone")?.score)
    .filter((s): s is number => typeof s === "number");
  const toneAdherenceAvg = toneScores.length
    ? toneScores.reduce((a, b) => a + b, 0) / toneScores.length
    : null;

  const draftAcceptanceRatePct = drafts.length
    ? Math.round(
        (drafts.filter((d) => isAcceptedOrMinor(d.body, d.sentText)).length / drafts.length) * 100,
      )
    : null;

  const closedWin = opportunities.filter((o) => o.status === "ACCEPTED" || o.status === "ROUTED_TO_PARTNER")
    .length;
  const salesIdConversionPct = opportunities.length
    ? Math.round((closedWin / opportunities.length) * 100)
    : null;

  return {
    responseTimeAdherencePct,
    toneAdherenceAvg,
    draftAcceptanceRatePct,
    salesIdConversionPct,
    sampleN,
  };
}

function extractDimension(
  payload: unknown,
  dim: string,
): { verdict?: string; score?: number } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const v = p[dim];
  if (!v || typeof v !== "object") return undefined;
  return v as { verdict?: string; score?: number };
}

function isAcceptedOrMinor(body: string, sent: string | null): boolean {
  if (!sent) return false;
  // §13.3 — "drafts sent unchanged or with minor edits (<10% character change)".
  const edits = levenshteinishLength(body, sent);
  return edits <= Math.max(20, Math.floor(body.length * 0.1));
}

/**
 * Cheap edit-distance-ish proxy. We don't need full Levenshtein for a 10%
 * threshold — character-count delta is good enough for the dashboard.
 * Use the symmetric difference of length when length differs; fall back
 * to per-position char compare when lengths are equal.
 */
function levenshteinishLength(a: string, b: string): number {
  if (a.length !== b.length) return Math.abs(a.length - b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff;
}

// ─── Mutating SlaTarget ────────────────────────────────────────────────────

export async function setSlaTargetThreshold(input: {
  code: string;
  threshold: number;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
}): Promise<SlaTarget> {
  const before = await superDb.slaTarget.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`sla: target ${input.code} not found`);
  if (input.threshold === before.threshold && (input.notes ?? null) === before.notes) {
    return before;
  }
  const updated = await superDb.slaTarget.update({
    where: { id: before.id },
    data: {
      threshold: input.threshold,
      notes: input.notes?.trim() ?? before.notes,
    },
  });
  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SLA_TARGET_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SlaTarget",
    subjectId: before.id,
    payload: {
      code: before.code,
      from: before.threshold,
      to: input.threshold,
    },
  });
  return updated;
}

export const SLA_KIND_LABELS: Record<SlaKind, string> = {
  AVAILABILITY: "Availability",
  LATENCY: "Latency",
};

export const OUTCOME_LABELS: Record<SlaOutcome, string> = {
  MET: "Met",
  MISSED: "Missed",
  INSUFFICIENT_DATA: "Insufficient data",
};

