import { superDb } from "@/lib/db";

/**
 * Post-PRD hardening item 100 — per-tenant cron threshold resolver.
 *
 * Single point of truth every relevant cron reads. Returns the merged
 * effective values: row-override-or-platform-default. Every knob is
 * exported alongside its default so a UI / test can render them
 * inline.
 *
 * **Bounds + clamping**: callers pass user-typed values via
 * `validateOverrideInput` before persisting; the resolver assumes
 * row values are already validated and just returns them. The
 * platform defaults are imported from each cron's owning lib so
 * "what's the default" stays single-sourced — change it there and
 * the resolver picks it up automatically.
 */

import { ADHERENCE_THRESHOLD, MIN_DEADLINED_SENDS } from "@/lib/drafts/adherence-monitor";
import {
  ACK_RATE_THRESHOLD as SENTIMENT_ACK_RATE_THRESHOLD,
  MIN_ESCALATED_FOR_ALERT as SENTIMENT_MIN_ESCALATED_FOR_ALERT,
} from "@/lib/sentiment/firm-ack-monitor";
import {
  ACK_RATE_THRESHOLD as ADHERENCE_ACK_RATE_THRESHOLD,
  MIN_ESCALATED_FOR_ALERT as ADHERENCE_MIN_ESCALATED_FOR_ALERT,
} from "@/lib/adherence/firm-ack-monitor";
import { STALE_THRESHOLD_HOURS as SENTIMENT_STALE_THRESHOLD_HOURS } from "@/lib/sentiment/stale-sweep";
import { STALE_THRESHOLD_HOURS as ADHERENCE_STALE_THRESHOLD_HOURS } from "@/lib/adherence/stale-sweep";

export type CronThresholdKey =
  | "adherenceThreshold"
  | "ackRateThreshold"
  | "staleThresholdHours"
  | "minDeadlinedSends"
  | "minEscalatedForAlert";

export type CronThresholds = Record<CronThresholdKey, number>;

/**
 * Platform defaults — exported so the UI can render "Default: X"
 * next to each input. Sentiment + adherence ack-rate defaults MUST
 * agree (single knob across both pillars per item 95); we assert
 * that at module load and export the agreed value. Same for the
 * stale-hours knob across the two stale-sweep crons.
 */
export const PLATFORM_DEFAULTS: CronThresholds = (() => {
  if (SENTIMENT_ACK_RATE_THRESHOLD !== ADHERENCE_ACK_RATE_THRESHOLD) {
    throw new Error(
      "ACK_RATE_THRESHOLD diverged between sentiment and adherence pillars. " +
        "These MUST agree per item 95 — single knob across both pillars.",
    );
  }
  if (SENTIMENT_MIN_ESCALATED_FOR_ALERT !== ADHERENCE_MIN_ESCALATED_FOR_ALERT) {
    throw new Error(
      "MIN_ESCALATED_FOR_ALERT diverged between sentiment and adherence pillars.",
    );
  }
  if (SENTIMENT_STALE_THRESHOLD_HOURS !== ADHERENCE_STALE_THRESHOLD_HOURS) {
    throw new Error(
      "STALE_THRESHOLD_HOURS diverged between sentiment and adherence stale-sweeps.",
    );
  }
  return {
    adherenceThreshold: ADHERENCE_THRESHOLD,
    ackRateThreshold: SENTIMENT_ACK_RATE_THRESHOLD,
    staleThresholdHours: SENTIMENT_STALE_THRESHOLD_HOURS,
    minDeadlinedSends: MIN_DEADLINED_SENDS,
    minEscalatedForAlert: SENTIMENT_MIN_ESCALATED_FOR_ALERT,
  };
})();

/**
 * Validation bounds. Anything outside these ranges is rejected by the
 * UI form-handler with a ValidationError. The resolver itself never
 * clamps — the row is either valid (saved) or rejected at write time.
 *
 * Bounds chosen to keep the operator from setting a degenerate value:
 *   - Rates: 0.05..0.99 (you can't sensibly set "trip when ack is 0%"
 *     or "100% required" — the former never fires, the latter always).
 *   - Stale hours: 1..168 (an hour minimum so we don't double-fire on
 *     the same row, a week max so it's still "stale" not "ancient").
 *   - Volume floors: 1..1000 (need at least one sample; thousand is
 *     defensive — even busy tenants don't see >1k governance events
 *     in a single ISO week).
 */
export const BOUNDS = {
  adherenceThreshold: { min: 0.05, max: 0.99 },
  ackRateThreshold: { min: 0.05, max: 0.99 },
  staleThresholdHours: { min: 1, max: 168 },
  minDeadlinedSends: { min: 1, max: 1000 },
  minEscalatedForAlert: { min: 1, max: 1000 },
} as const;

export type CronThresholdRow = {
  adherenceThreshold: number | null;
  ackRateThreshold: number | null;
  staleThresholdHours: number | null;
  minDeadlinedSends: number | null;
  minEscalatedForAlert: number | null;
};

/**
 * Returns the effective thresholds for a tenant: row-override-or-default.
 *
 * Tenants without a row use every default — most tenants will be in
 * this state at launch. The `findUnique` is one query; in steady state
 * we could cache but the cron-side caller is at most every-5-min
 * cadence so the read amortises easily.
 */
export async function resolveCronThresholds(tenantId: string): Promise<CronThresholds> {
  const row = await superDb.tenantCronThreshold.findUnique({
    where: { tenantId },
  });
  return mergeWithDefaults(row);
}

/**
 * Pure merge — exported for tests + the /admin/sensitivity page so the
 * UI can render the effective values without re-fetching.
 */
export function mergeWithDefaults(row: CronThresholdRow | null): CronThresholds {
  if (!row) return { ...PLATFORM_DEFAULTS };
  return {
    adherenceThreshold: row.adherenceThreshold ?? PLATFORM_DEFAULTS.adherenceThreshold,
    ackRateThreshold: row.ackRateThreshold ?? PLATFORM_DEFAULTS.ackRateThreshold,
    staleThresholdHours: row.staleThresholdHours ?? PLATFORM_DEFAULTS.staleThresholdHours,
    minDeadlinedSends: row.minDeadlinedSends ?? PLATFORM_DEFAULTS.minDeadlinedSends,
    minEscalatedForAlert:
      row.minEscalatedForAlert ?? PLATFORM_DEFAULTS.minEscalatedForAlert,
  };
}

/**
 * Validate a single incoming knob value. Returns null for "use default"
 * (caller passed empty/null), the validated number on success, throws
 * `ValidationError`-shaped Error on out-of-bounds. Rates accept 0.05..0.99
 * as floats; integer knobs accept integer inputs only.
 */
export function validateOverrideInput(
  key: CronThresholdKey,
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid number for ${key}: ${raw}`);
  }
  const isInt = key !== "adherenceThreshold" && key !== "ackRateThreshold";
  if (isInt && !Number.isInteger(num)) {
    throw new Error(`${key} must be an integer (got ${num})`);
  }
  const { min, max } = BOUNDS[key];
  if (num < min || num > max) {
    throw new Error(`${key} must be between ${min} and ${max} (got ${num})`);
  }
  return num;
}
