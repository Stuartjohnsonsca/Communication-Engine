import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";
import { evaluateCronHealth, type CronStatus } from "./evaluate";
import { writeCronAuditOnAcumon, acumonTenantId } from "./audit";

export type HealthCheckResult = {
  evaluated: number;
  alerted: number;
  alerts: Array<{ cronName: string; state: CronStatus["state"] }>;
  /// Per-cron snapshot; useful for the cron response log.
  statuses: CronStatus[];
};

/**
 * Run a health-check pass: evaluate every registered cron, alert on any
 * that are `stalled` or `failing` (subject to the dedupe window).
 *
 * Dedupe: an alert re-fires only after `expectedIntervalMinutes` has elapsed
 * since `stalledNotifiedAt`. This means an operator sees one alert per
 * genuine stall window — not one every 15min (the health-check cadence).
 *
 * Audit event lands on the Acumon operator tenant chain (`CRON_STALLED`).
 * Immediate notification dispatched to every active Acumon FIRM_ADMIN /
 * ACUMON_ADMIN via `dispatchCronStalled` (which lazy-imports the
 * notifications module to keep the dependency graph clean).
 *
 * Safe to call concurrently — the dedupe write uses a conditional UPDATE
 * with `where: { stalledNotifiedAt: <previous value> }` so two racing
 * health-check passes can't both fire an alert.
 *
 * `now` is injectable for tests.
 */
export async function runHealthCheck(now: Date = new Date()): Promise<HealthCheckResult> {
  const statuses = await evaluateCronHealth(now);
  const alerts: HealthCheckResult["alerts"] = [];

  for (const status of statuses) {
    if (status.state !== "stalled" && status.state !== "failing") continue;
    // Don't fire stall alerts on the health-check cron itself — if THIS
    // cron is stalled, nobody will see the alert until it runs again. The
    // operator must rely on Railway's own out-of-band alerting for that.
    if (status.cronName === "health-check") continue;

    const shouldAlert = await markAlertFiredIfDue(status, now);
    if (!shouldAlert) continue;

    await emitStalledAlert(status);
    alerts.push({ cronName: status.cronName, state: status.state });
  }

  return {
    evaluated: statuses.length,
    alerted: alerts.length,
    alerts,
    statuses,
  };
}

/**
 * Atomically claim the alert slot for `status.cronName`. Returns true iff
 * THIS caller should fire the alert. Implementation: conditional UPDATE
 * keyed on the row's current `stalledNotifiedAt` — only the first racer
 * sees a row count of 1.
 */
async function markAlertFiredIfDue(status: CronStatus, now: Date): Promise<boolean> {
  // First-time alert: row may not exist yet (state === "never-run"); create
  // it with stalledNotifiedAt = now so subsequent passes dedupe.
  if (status.state === "never-run") {
    // never-run is a soft state — we don't alert on a cron that has never
    // run, because the operator hasn't yet wired the schedule. Once it has
    // at least one run we can meaningfully say "stopped running".
    return false;
  }

  const previousNotifiedAt = status.stalledNotifiedAt;
  if (previousNotifiedAt) {
    const sinceLastMs = now.getTime() - previousNotifiedAt.getTime();
    const cooldownMs = status.expectedIntervalMinutes * 60_000;
    if (sinceLastMs < cooldownMs) return false;
  }

  const expectation = previousNotifiedAt
    ? { stalledNotifiedAt: previousNotifiedAt }
    : { stalledNotifiedAt: null };

  const result = await superDb.cronHeartbeat.updateMany({
    where: {
      cronName: status.cronName,
      ...expectation,
    },
    data: { stalledNotifiedAt: now },
  });
  return result.count === 1;
}

async function emitStalledAlert(status: CronStatus): Promise<void> {
  await writeCronAuditOnAcumon("CRON_STALLED", status.cronName, {
    cronName: status.cronName,
    state: status.state,
    lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: status.lastFailureAt?.toISOString() ?? null,
    lastErrorMessage: status.lastErrorMessage,
    consecutiveFailures: status.consecutiveFailures,
    expectedIntervalMinutes: status.expectedIntervalMinutes,
  });

  try {
    const acumonId = await acumonTenantId();
    if (!acumonId) return;
    // Lazy import to avoid a circular load chain — the notifications/index
    // barrel pulls in audit, which we already use here.
    const { dispatchCronStalled } = await import("@/lib/notifications/immediate");
    await dispatchCronStalled({
      tenantId: acumonId,
      cronName: status.cronName,
      state: status.state,
      lastSuccessAt: status.lastSuccessAt,
      lastErrorMessage: status.lastErrorMessage,
      consecutiveFailures: status.consecutiveFailures,
      expectedIntervalMinutes: status.expectedIntervalMinutes,
    });
  } catch (err) {
    reportError(err, { tags: { kind: "cron-stalled-notify", cronName: status.cronName } });
  }
}
