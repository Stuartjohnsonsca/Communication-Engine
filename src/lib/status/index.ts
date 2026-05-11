import type {
  AccessibilityStatement,
  BreachIncident,
  BreachSeverity,
  BreachStatus,
  SlaKind,
  SlaTarget,
  SubProcessor,
  TermsKind,
} from "@prisma/client";
import { superDb } from "@/lib/db";

/**
 * Backlog item 9 — public `/status` aggregator.
 *
 * Marketing/procurement-facing surface that lives outside the tenant slug
 * and outside auth. Data sources are deliberately the ones that already
 * have a published-in-public commitment in the PRD:
 *   - SLA: §13.1 SlaTarget (catalogue) + cross-tenant SlaMeasurement
 *     adherence rollup for the current period (anonymised — no tenant
 *     attribution leaves this surface).
 *   - Incidents: §12.9 BreachIncident, last 90 days, redacted to drop
 *     affected-tenant identity (count of affected clients is fine — the
 *     identity is not).
 *   - Sub-processors: §15.3 SubProcessor (already public via the tenant
 *     /switching page; same data).
 *   - Accessibility: §13.4 AccessibilityStatement (already published).
 *   - Terms model: §15.4 TermsKind catalogue — we don't expose any one
 *     tenant's contract; just the versioning model + the latest version
 *     number we've cut for any tenant per kind, as a signal that the
 *     versioning machinery is real.
 *
 * Queries use `superDb` because there is no tenant context (the page is
 * unauthenticated). Every read here is from data that the product
 * already classifies as public.
 */

const RECENT_INCIDENT_WINDOW_DAYS = 90;

export type SlaRollup = {
  target: SlaTarget;
  /** Most recent period that has any measurement at all. */
  period: string | null;
  /** Number of tenants with a measurement for that period. */
  tenantsMeasured: number;
  /** Number of MET outcomes for that period across all tenants. */
  met: number;
  /** Number of MISSED outcomes for that period across all tenants. */
  missed: number;
  /** Number of INSUFFICIENT_DATA outcomes for that period across all tenants. */
  insufficient: number;
  /** Sum of sampleN across all measured tenants for that period. */
  sampleN: number;
  /**
   * Aggregate observed value across tenants for the period. For
   * AVAILABILITY targets this is the mean of `observed` weighted by
   * `sampleN`; for LATENCY the median of medians (each tenant
   * contributes one observed median; we take the median of those, which
   * matches the §13.1 wording without giving any one tenant the power to
   * skew the public number).
   */
  aggregateObserved: number | null;
  /** Whether `aggregateObserved` clears `target.threshold`. */
  aggregateOutcome: "MET" | "MISSED" | "INSUFFICIENT_DATA";
  /**
   * Per-period trend for the most recent N periods (oldest → newest).
   * Each entry shows the aggregate outcome for that period, so a
   * procurement reviewer can tell "missed once" from "missing every
   * month". Periods with no measurement appear as INSUFFICIENT_DATA so
   * the trend has a stable length. Never reveals tenant identity.
   */
  recentPeriods: SlaTrendPoint[];
};

export type SlaTrendPoint = {
  /** YYYY-MM. */
  period: string;
  outcome: "MET" | "MISSED" | "INSUFFICIENT_DATA";
  /** Aggregate observed (same shape as `aggregateObserved`). */
  observed: number | null;
};

export type RedactedIncident = {
  code: string;
  title: string;
  /** Markdown body. Tenant identifiers are not part of the description by
   * convention — the operator records narrative, not customer names — but
   * we still apply a defensive scrub for slugs that look like tenant codes. */
  description: string;
  severity: BreachSeverity;
  status: BreachStatus;
  /** Whether the incident was classified as a personal-data breach. */
  isPersonalData: boolean;
  awareAt: Date;
  detectedAt: Date | null;
  containedAt: Date | null;
  resolvedAt: Date | null;
  /** Affected client COUNT only — identities never leave the operator side. */
  affectedClientCount: number;
  /** Categories of data potentially affected (operator-recorded strings). */
  affectedCategories: string[];
};

export type TermsKindStatus = {
  kind: TermsKind;
  description: string;
  /**
   * Highest version number we have cut for any tenant. Null if we have
   * not yet recorded a version of this kind. Tenant identity is not
   * exposed — only the maximum version, as a signal the surface is
   * actively maintained.
   */
  latestVersion: number | null;
  /** Most recent updatedAt across all tenants for this kind. */
  lastUpdatedAt: Date | null;
};

export type PublicStatus = {
  generatedAt: Date;
  sla: SlaRollup[];
  incidents: RedactedIncident[];
  subProcessors: SubProcessor[];
  accessibility: AccessibilityStatement | null;
  terms: TermsKindStatus[];
};

export async function getPublicStatus(): Promise<PublicStatus> {
  const [targets, allMeasurements, recentIncidents, subProcessors, accessibility, termsRows] =
    await Promise.all([
      superDb.slaTarget.findMany({ where: { isActive: true }, orderBy: { ordinal: "asc" } }),
      // Pull the last 6 months across all tenants — keeps the query bounded
      // while still letting us pick the most recent period that any tenant
      // produced a measurement for, even if some tenants haven't run their
      // monthly close yet.
      superDb.slaMeasurement.findMany({
        where: { period: { in: lastNPeriods(6) } },
        orderBy: { period: "desc" },
      }),
      superDb.breachIncident.findMany({
        where: {
          awareAt: {
            gte: new Date(Date.now() - RECENT_INCIDENT_WINDOW_DAYS * 24 * 3_600_000),
          },
        },
        orderBy: { awareAt: "desc" },
        take: 25,
      }),
      superDb.subProcessor.findMany({
        where: { isActive: true },
        orderBy: { ordinal: "asc" },
      }),
      superDb.accessibilityStatement.findFirst({
        where: { isActive: true },
        orderBy: { version: "desc" },
      }),
      superDb.termsRecord.groupBy({
        by: ["kind"],
        _max: { version: true, updatedAt: true },
      }),
    ]);

  const sla = targets.map((target) => buildSlaRollup(target, allMeasurements));
  const incidents = recentIncidents.map(redactIncident);
  const terms = buildTermsCatalogue(termsRows);

  return {
    generatedAt: new Date(),
    sla,
    incidents,
    subProcessors,
    accessibility,
    terms,
  };
}

type MeasurementSlice = {
  targetId: string;
  period: string;
  observed: number | null;
  outcome: "MET" | "MISSED" | "INSUFFICIENT_DATA";
  sampleN: number;
};

function aggregatePeriod(
  target: SlaTarget,
  slice: MeasurementSlice[],
): { observed: number | null; outcome: "MET" | "MISSED" | "INSUFFICIENT_DATA" } {
  if (slice.length === 0) return { observed: null, outcome: "INSUFFICIENT_DATA" };
  const observedValues = slice
    .map((m) => m.observed)
    .filter((v): v is number => typeof v === "number");

  let aggregateObserved: number | null = null;
  if (observedValues.length > 0) {
    if (target.kind === "AVAILABILITY") {
      const totalSample = slice.reduce(
        (acc, m) => acc + (m.observed != null ? m.sampleN || 1 : 0),
        0,
      );
      aggregateObserved =
        totalSample === 0
          ? observedValues.reduce((a, b) => a + b, 0) / observedValues.length
          : slice.reduce(
              (acc, m) => (m.observed != null ? acc + m.observed * (m.sampleN || 1) : acc),
              0,
            ) / totalSample;
    } else {
      const sorted = [...observedValues].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      aggregateObserved =
        sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    }
  }
  let outcome: "MET" | "MISSED" | "INSUFFICIENT_DATA";
  if (aggregateObserved == null) {
    outcome = "INSUFFICIENT_DATA";
  } else if (target.kind === "AVAILABILITY") {
    outcome = aggregateObserved >= target.threshold ? "MET" : "MISSED";
  } else {
    outcome = aggregateObserved <= target.threshold ? "MET" : "MISSED";
  }
  return { observed: aggregateObserved, outcome };
}

function buildSlaRollup(target: SlaTarget, measurements: MeasurementSlice[]): SlaRollup {
  const own = measurements.filter((m) => m.targetId === target.id);

  // Trend: every period in the lookback window, oldest → newest. Periods
  // with no measurement still appear as INSUFFICIENT_DATA so the public
  // bar has a stable length and a "gap" is visible.
  const periods = lastNPeriods(6).slice().reverse(); // oldest → newest
  const recentPeriods: SlaTrendPoint[] = periods.map((period) => {
    const slice = own.filter((m) => m.period === period);
    const { observed, outcome } = aggregatePeriod(target, slice);
    return { period, outcome, observed };
  });

  if (own.length === 0) {
    return {
      target,
      period: null,
      tenantsMeasured: 0,
      met: 0,
      missed: 0,
      insufficient: 0,
      sampleN: 0,
      aggregateObserved: null,
      aggregateOutcome: "INSUFFICIENT_DATA",
      recentPeriods,
    };
  }

  // The most recent period that has any measurement of this target across
  // any tenant.
  const period = own
    .map((m) => m.period)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))[0]!;
  const slice = own.filter((m) => m.period === period);

  const met = slice.filter((m) => m.outcome === "MET").length;
  const missed = slice.filter((m) => m.outcome === "MISSED").length;
  const insufficient = slice.filter((m) => m.outcome === "INSUFFICIENT_DATA").length;
  const sampleN = slice.reduce((acc, m) => acc + (m.sampleN ?? 0), 0);

  const { observed: aggregateObserved, outcome: aggregateOutcome } = aggregatePeriod(
    target,
    slice,
  );

  return {
    target,
    period,
    tenantsMeasured: slice.length,
    met,
    missed,
    insufficient,
    sampleN,
    aggregateObserved,
    aggregateOutcome,
    recentPeriods,
  };
}

function redactIncident(i: BreachIncident): RedactedIncident {
  // The description is operator-authored and is not supposed to carry
  // customer identifiers, but a careless paste could leak a slug. Strip
  // anything that looks like the [tenant: <slug>] pattern that some
  // operator notes use. (The full operator console retains the raw text;
  // only the public surface is scrubbed.)
  const description = i.description
    .replace(/\[tenant:\s*[a-z0-9_-]+\s*\]/gi, "[tenant redacted]")
    .replace(/tenant:[a-z0-9_-]+/gi, "tenant:[redacted]");
  return {
    code: i.code,
    title: i.title,
    description,
    severity: i.severity,
    status: i.status,
    isPersonalData: i.isPersonalData,
    awareAt: i.awareAt,
    detectedAt: i.detectedAt,
    containedAt: i.containedAt,
    resolvedAt: i.resolvedAt,
    affectedClientCount: i.affectedClientCount,
    affectedCategories: i.affectedCategories,
  };
}

function buildTermsCatalogue(
  rows: Array<{ kind: TermsKind; _max: { version: number | null; updatedAt: Date | null } }>,
): TermsKindStatus[] {
  const byKind = new Map(rows.map((r) => [r.kind, r._max]));
  const catalogue: Array<{ kind: TermsKind; description: string }> = [
    { kind: "MSA", description: "Master Services Agreement" },
    { kind: "DPA", description: "Data Processing Addendum" },
    { kind: "AUP", description: "Acceptable Use Policy" },
    { kind: "SLA", description: "Service Level Agreement" },
  ];
  return catalogue.map(({ kind, description }) => {
    const max = byKind.get(kind);
    return {
      kind,
      description,
      latestVersion: max?.version ?? null,
      lastUpdatedAt: max?.updatedAt ?? null,
    };
  });
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

export const SLA_KIND_LABELS: Record<SlaKind, string> = {
  AVAILABILITY: "Availability",
  LATENCY: "Latency",
};

export const SEVERITY_LABELS: Record<BreachSeverity, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

export const STATUS_LABELS: Record<BreachStatus, string> = {
  TRIAGE: "Triage",
  INVESTIGATING: "Investigating",
  CONTAINED: "Contained",
  RESOLVED: "Resolved",
};
