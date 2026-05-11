import { Client } from "pg";
import { createHash } from "node:crypto";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 47 — pg advisory-lock based concurrency gate
 * around every cron run.
 *
 * Each cron job is engineered to be idempotent (digest dedupes on ISO
 * week, webhooks-deliver claims rows via IN_FLIGHT, lifecycle-sweep
 * does per-row state transitions, audit-verify atomically claims
 * `notifiedAt`, etc.), so a concurrent run is mostly a wasted DB
 * traversal rather than a correctness bug. The lock is defence in
 * depth + a CPU/connection-pool reducer: two simultaneous
 * audit-verify passes would each do the full per-tenant hash walk,
 * which is the largest read in the platform.
 *
 * Implementation:
 *   - One dedicated `pg.Client` per acquire/release cycle. We cannot
 *     reuse Prisma's pool because session-level advisory locks must be
 *     acquired and released on the same connection, and Prisma may
 *     return a different connection between two raw queries.
 *   - `pg_try_advisory_lock(int4, int4)` — non-blocking. If the lock
 *     is held by another session, returns false; we throw
 *     `CronSkippedError` and the caller (`withCronHeartbeat`) records
 *     the skip.
 *   - Released via `pg_advisory_unlock(...)` in `finally`. The
 *     session-scoped lock would auto-release on `client.end()`
 *     anyway, but the explicit unlock makes the intent obvious and
 *     gives faster turnaround for the next scheduled invocation.
 *
 * Escape hatch: setting `CRON_CONCURRENCY_LOCK=off` bypasses the lock
 * entirely. Useful for the integration test suite where parallel
 * `withCronHeartbeat` calls intentionally race for failure-mode
 * coverage. Default behaviour (production + dev) is locked.
 *
 * Key derivation: `(NAMESPACE, hash(cronName))`. NAMESPACE is a fixed
 * 31-bit integer specific to this codebase so we cannot collide with
 * any future advisory lock taken by another part of the app.
 */

export class CronSkippedError extends Error {
  readonly reason: "concurrent";
  readonly cronName: string;
  constructor(cronName: string) {
    super(`Cron "${cronName}" skipped: another run is in flight`);
    this.name = "CronSkippedError";
    this.cronName = cronName;
    this.reason = "concurrent";
  }
}

const LOCK_NAMESPACE = 0x4163_756d; // 'Acum' — distinct, fixed 31-bit int.

function cronLockKey(cronName: string): number {
  // First 4 bytes of SHA-256; mask to 31 bits so it fits in a positive
  // signed int4 (Postgres `pg_try_advisory_lock` second arg is int4).
  const buf = createHash("sha256").update(cronName).digest();
  return buf.readInt32BE(0) & 0x7fff_ffff;
}

export type WithCronLockOptions = {
  /** Override the connection string. Tests + alternative deployments. */
  databaseUrl?: string;
};

/**
 * Run `fn` while holding a Postgres advisory lock keyed on cronName.
 * Throws `CronSkippedError` if the lock cannot be acquired.
 *
 * Bypass when `CRON_CONCURRENCY_LOCK=off` — the test suite uses this
 * to keep parallel `withCronHeartbeat` invocations from blocking each
 * other in the failure-mode tests.
 */
export async function withCronLock<T>(
  cronName: string,
  fn: () => Promise<T>,
  options: WithCronLockOptions = {},
): Promise<T> {
  if (process.env.CRON_CONCURRENCY_LOCK === "off") {
    return fn();
  }
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    // No DB? Then there's no other instance to race against either.
    // Equivalent to "we couldn't lock, but it doesn't matter."
    return fn();
  }
  const client = new Client({ connectionString: url });
  const key1 = LOCK_NAMESPACE;
  const key2 = cronLockKey(cronName);
  await client.connect();
  try {
    const got = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [key1, key2],
    );
    const acquired = got.rows[0]?.acquired === true;
    if (!acquired) {
      throw new CronSkippedError(cronName);
    }
    try {
      return await fn();
    } finally {
      // Best-effort unlock. The session-scoped lock auto-releases on
      // `client.end()` below; the explicit unlock just frees the key
      // sooner for the next scheduled run.
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [key1, key2]);
      } catch (err) {
        reportError(err, {
          tags: { kind: "cron-lock", cronName, phase: "unlock" },
        });
      }
    }
  } finally {
    try {
      await client.end();
    } catch (err) {
      reportError(err, {
        tags: { kind: "cron-lock", cronName, phase: "client-end" },
      });
    }
  }
}
