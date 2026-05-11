import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";
import { registeredCron } from "./register";

/**
 * Wrap a cron handler with heartbeat recording.
 *
 * Records:
 *   - `lastRunAt` unconditionally (so we can see when a cron last ATTEMPTED,
 *     not just when it succeeded — useful for debugging an auth-failure storm)
 *   - On success: `lastSuccessAt`, `lastDurationMs`, resets
 *     `consecutiveFailures` to 0
 *   - On throw: `lastFailureAt`, `lastErrorMessage` (first 500 chars),
 *     increments `consecutiveFailures`
 *
 * The wrapper RE-THROWS on failure so the cron endpoint's response signals
 * the error to the scheduler (Railway can then alert via its own pathway).
 * The heartbeat write happens in a `finally` so a partial write doesn't lose
 * the run record.
 *
 * Refuses unknown cron names — the cron has to be declared in
 * `register.ts` so the health-check worker can evaluate it.
 */
export async function withCronHeartbeat<T>(
  cronName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const registration = registeredCron(cronName);
  if (!registration) {
    throw new Error(
      `withCronHeartbeat: unknown cron name "${cronName}" — add it to src/lib/cron-health/register.ts`,
    );
  }

  const startedAt = new Date();
  await markRunStarted(cronName, registration.expectedIntervalMinutes, startedAt);

  try {
    const result = await fn();
    await markRunSucceeded(cronName, startedAt);
    return result;
  } catch (err) {
    await markRunFailed(cronName, err);
    throw err;
  }
}

async function markRunStarted(
  cronName: string,
  expectedIntervalMinutes: number,
  startedAt: Date,
): Promise<void> {
  try {
    await superDb.cronHeartbeat.upsert({
      where: { cronName },
      create: {
        cronName,
        expectedIntervalMinutes,
        lastRunAt: startedAt,
      },
      update: {
        // Keep expectedIntervalMinutes in sync with the registration in case
        // the cadence was tuned since the row was first written.
        expectedIntervalMinutes,
        lastRunAt: startedAt,
      },
    });
  } catch (err) {
    // Heartbeat is observability — never fail the cron because of it.
    reportError(err, { tags: { kind: "cron-heartbeat", cronName, phase: "start" } });
  }
}

async function markRunSucceeded(cronName: string, startedAt: Date): Promise<void> {
  const finishedAt = Date.now();
  const durationMs = Math.max(0, finishedAt - startedAt.getTime());
  try {
    await superDb.cronHeartbeat.update({
      where: { cronName },
      data: {
        lastSuccessAt: new Date(finishedAt),
        lastDurationMs: durationMs,
        consecutiveFailures: 0,
        lastErrorMessage: null,
      },
    });
  } catch (err) {
    reportError(err, { tags: { kind: "cron-heartbeat", cronName, phase: "success" } });
  }
}

async function markRunFailed(cronName: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const truncated = message.slice(0, 500);
  try {
    await superDb.cronHeartbeat.update({
      where: { cronName },
      data: {
        lastFailureAt: new Date(),
        lastErrorMessage: truncated,
        consecutiveFailures: { increment: 1 },
      },
    });
    // Failure also fires an audit event on the Acumon operator chain so the
    // chain has a forensic record without waiting for the next health-check
    // pass. Lazy-import to dodge a circular load (`audit.ts` doesn't import
    // cron-health, but cron-health is called from cron endpoints which
    // indirectly load anything; keeping the audit import lazy here is
    // defensive).
    const { writeCronAuditOnAcumon } = await import("./audit");
    await writeCronAuditOnAcumon("CRON_RUN_FAILED", cronName, {
      cronName,
      errorMessage: truncated,
    });
  } catch (auditErr) {
    reportError(auditErr, { tags: { kind: "cron-heartbeat", cronName, phase: "failure" } });
  }
}
