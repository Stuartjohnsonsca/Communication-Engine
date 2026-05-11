import { superDb } from "@/lib/db";
import { REGISTERED_CRONS, type RegisteredCron } from "./register";

export type CronHealthState = "ok" | "stalled" | "never-run" | "failing";

export type CronStatus = {
  cronName: string;
  expectedIntervalMinutes: number;
  description: string;
  state: CronHealthState;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorMessage: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  stalledNotifiedAt: Date | null;
};

const FAILING_FAILURE_THRESHOLD = 3;
const STALL_INTERVAL_MULTIPLIER = 2;

/**
 * Evaluate the health of every registered cron.
 *
 *   `never-run` — no heartbeat row exists OR `lastSuccessAt` is null AND the
 *                 cron has had at least 2× its expected interval since
 *                 boot to make its first run (so we don't flag a brand-new
 *                 minute-cron as stalled within its first 2min).
 *   `stalled`   — `lastSuccessAt` is older than 2× the expected interval.
 *   `failing`   — `consecutiveFailures >= 3`. The cron is still trying but
 *                 not succeeding — operator should investigate even if it's
 *                 not yet past the stall window.
 *   `ok`        — none of the above.
 *
 * Reads via `superDb` — there's no tenantId on CronHeartbeat (platform-wide).
 *
 * `now` is injectable for tests; defaults to `new Date()`.
 */
export async function evaluateCronHealth(now: Date = new Date()): Promise<CronStatus[]> {
  const rows = await superDb.cronHeartbeat.findMany();
  const rowsByName = new Map(rows.map((r) => [r.cronName, r]));

  return REGISTERED_CRONS.map((reg) => {
    const row = rowsByName.get(reg.cronName);
    return statusFor(reg, row ?? null, now);
  });
}

function statusFor(
  reg: RegisteredCron,
  row: Awaited<ReturnType<typeof superDb.cronHeartbeat.findMany>>[number] | null,
  now: Date,
): CronStatus {
  if (!row) {
    return {
      cronName: reg.cronName,
      expectedIntervalMinutes: reg.expectedIntervalMinutes,
      description: reg.description,
      state: "never-run",
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorMessage: null,
      lastDurationMs: null,
      consecutiveFailures: 0,
      stalledNotifiedAt: null,
    };
  }

  let state: CronHealthState = "ok";
  if (!row.lastSuccessAt) {
    state = "never-run";
  } else {
    const ageMs = now.getTime() - row.lastSuccessAt.getTime();
    const stallThresholdMs = reg.expectedIntervalMinutes * STALL_INTERVAL_MULTIPLIER * 60_000;
    if (ageMs > stallThresholdMs) {
      state = "stalled";
    } else if (row.consecutiveFailures >= FAILING_FAILURE_THRESHOLD) {
      state = "failing";
    }
  }

  return {
    cronName: reg.cronName,
    expectedIntervalMinutes: reg.expectedIntervalMinutes,
    description: reg.description,
    state,
    lastRunAt: row.lastRunAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastErrorMessage: row.lastErrorMessage,
    lastDurationMs: row.lastDurationMs,
    consecutiveFailures: row.consecutiveFailures,
    stalledNotifiedAt: row.stalledNotifiedAt,
  };
}
