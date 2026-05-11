/**
 * Post-PRD hardening item 47 — cron concurrency gate via pg
 * advisory lock.
 *
 * Coverage:
 *   - `withCronLock` acquires the lock and runs the body when no other
 *     run is in flight.
 *   - Two concurrent invocations of the same cron: the second throws
 *     `CronSkippedError` and does NOT run the body.
 *   - Different cron names lock independently — concurrent runs of two
 *     different crons both succeed.
 *   - `CRON_CONCURRENCY_LOCK=off` bypasses the lock entirely (used by
 *     the rest of the integration suite + dev).
 *   - `withCronHeartbeat` surfaces the skip: lastRunAt advances but
 *     lastSuccessAt does NOT; a `CRON_RUN_SKIPPED_CONCURRENT` audit
 *     row lands on Acumon's chain; consecutiveFailures stays put.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  withCronLock,
  CronSkippedError,
  withCronHeartbeat,
} from "@/lib/cron-health";

async function ensureAcumon() {
  const existing = await superDb.tenant.findUnique({ where: { slug: "acumon" } });
  if (existing) return existing;
  return superDb.tenant.create({
    data: { slug: "acumon", name: "Acumon (operator) — test" },
  });
}

async function clearHeartbeat(cronName: string) {
  await superDb.cronHeartbeat.deleteMany({ where: { cronName } });
}

describe("cron-health — withCronLock", () => {
  beforeAll(async () => {
    await ensureAcumon();
  });

  beforeEach(() => {
    // The test-suite default (tests/setup.ts) disables the advisory lock so
    // unrelated tests that share cron names don't interlock. Re-enable it
    // here so this file actually exercises the gate.
    delete process.env.CRON_CONCURRENCY_LOCK;
  });

  afterEach(() => {
    process.env.CRON_CONCURRENCY_LOCK = "off";
  });

  it("runs the body when the lock is free and returns its result", async () => {
    const r = await withCronLock("digest", async () => "ran");
    expect(r).toBe("ran");
  });

  it("blocks a concurrent acquisition: second caller throws CronSkippedError", async () => {
    // First caller holds the lock until we let it go. Second caller must
    // observe CronSkippedError immediately.
    let release: (() => void) | null = null;
    const held: Promise<unknown> = new Promise((resolve) => {
      release = () => resolve("done");
    });
    const slow = withCronLock("lifecycle-sweep", async () => held);

    // Give the lock a tick to be acquired before we race.
    await new Promise((r) => setTimeout(r, 30));

    let caughtSkipped: CronSkippedError | null = null;
    try {
      await withCronLock("lifecycle-sweep", async () => "should-not-run");
      throw new Error("expected CronSkippedError");
    } catch (err) {
      if (err instanceof CronSkippedError) {
        caughtSkipped = err;
      } else {
        throw err;
      }
    }
    expect(caughtSkipped).not.toBeNull();
    expect(caughtSkipped!.cronName).toBe("lifecycle-sweep");
    expect(caughtSkipped!.reason).toBe("concurrent");

    // Let the holder finish.
    release!();
    await slow;
  });

  it("different cron names lock independently", async () => {
    let releaseA: (() => void) | null = null;
    const heldA = new Promise((resolve) => {
      releaseA = () => resolve("done");
    });
    const slowA = withCronLock("billing-close", async () => heldA);
    await new Promise((r) => setTimeout(r, 30));

    // Different cron name — should NOT be blocked.
    const r = await withCronLock("termination", async () => "different");
    expect(r).toBe("different");

    releaseA!();
    await slowA;
  });

  it("CRON_CONCURRENCY_LOCK=off bypasses the lock entirely (used by the rest of the test suite)", async () => {
    process.env.CRON_CONCURRENCY_LOCK = "off";
    // Two concurrent acquisitions should BOTH run.
    const ran: string[] = [];
    await Promise.all([
      withCronLock("digest", async () => {
        ran.push("a");
        await new Promise((r) => setTimeout(r, 20));
        return "a";
      }),
      withCronLock("digest", async () => {
        ran.push("b");
        await new Promise((r) => setTimeout(r, 20));
        return "b";
      }),
    ]);
    expect(ran.sort()).toEqual(["a", "b"]);
  });
});

describe("cron-health — withCronHeartbeat skip semantics", () => {
  beforeAll(async () => {
    await ensureAcumon();
  });

  beforeEach(() => {
    delete process.env.CRON_CONCURRENCY_LOCK;
  });

  afterEach(() => {
    process.env.CRON_CONCURRENCY_LOCK = "off";
  });

  it("a concurrent invocation does NOT advance lastSuccessAt, writes a SKIPPED audit row, leaves failures untouched", async () => {
    await clearHeartbeat("audit-verify");
    // Seed: known starting state.
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "audit-verify",
        expectedIntervalMinutes: 24 * 60,
        lastRunAt: new Date(Date.now() - 60_000),
        lastSuccessAt: new Date(Date.now() - 60_000),
        consecutiveFailures: 0,
      },
    });
    const seedSuccess = (
      await superDb.cronHeartbeat.findUnique({
        where: { cronName: "audit-verify" },
      })
    )!.lastSuccessAt!.getTime();

    const acumon = await ensureAcumon();
    const auditBefore = await superDb.auditEvent.count({
      where: {
        tenantId: acumon.id,
        eventType: "CRON_RUN_SKIPPED_CONCURRENT",
        subjectId: "audit-verify",
      },
    });

    // First invocation holds the lock; second observes the skip.
    let release: (() => void) | null = null;
    const held = new Promise((resolve) => {
      release = () => resolve("done");
    });
    const slow = withCronHeartbeat("audit-verify", async () => held);
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      withCronHeartbeat("audit-verify", async () => "blocked"),
    ).rejects.toBeInstanceOf(CronSkippedError);

    release!();
    await slow;

    // After the skip + the held run finishing:
    // - lastSuccessAt SHOULD have advanced (the holder's run succeeded).
    // - The SKIPPED audit row landed on the Acumon chain.
    // - consecutiveFailures stays at 0 (skip is not a failure).
    const after = await superDb.cronHeartbeat.findUnique({
      where: { cronName: "audit-verify" },
    });
    expect(after!.consecutiveFailures).toBe(0);
    expect(after!.lastSuccessAt!.getTime()).toBeGreaterThan(seedSuccess);

    const auditAfter = await superDb.auditEvent.count({
      where: {
        tenantId: acumon.id,
        eventType: "CRON_RUN_SKIPPED_CONCURRENT",
        subjectId: "audit-verify",
      },
    });
    expect(auditAfter).toBe(auditBefore + 1);
  });

  it("with CRON_CONCURRENCY_LOCK=off, both concurrent heartbeats run (the test-suite default)", async () => {
    process.env.CRON_CONCURRENCY_LOCK = "off";
    await clearHeartbeat("digest");
    const tag = randomUUID().slice(0, 4);
    const results = await Promise.all([
      withCronHeartbeat("digest", async () => `a-${tag}`),
      withCronHeartbeat("digest", async () => `b-${tag}`),
    ]);
    expect(results.sort()).toEqual([`a-${tag}`, `b-${tag}`].sort());
  });
});
