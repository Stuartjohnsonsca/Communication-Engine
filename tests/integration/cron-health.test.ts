/**
 * Cron heartbeat monitoring (post-PRD hardening item 22).
 *
 * Coverage:
 *   - withCronHeartbeat upserts the row, records lastRunAt + lastSuccessAt
 *     + lastDurationMs on success, resets consecutiveFailures to 0.
 *   - withCronHeartbeat records lastFailureAt + lastErrorMessage and
 *     increments consecutiveFailures on throw; rethrows the original error.
 *   - withCronHeartbeat refuses unknown cron names.
 *   - evaluateCronHealth flags `never-run` for crons with no row.
 *   - evaluateCronHealth flags `stalled` for lastSuccessAt > 2× interval.
 *   - evaluateCronHealth flags `failing` for consecutiveFailures >= 3.
 *   - runHealthCheck writes CRON_STALLED audit + dispatches notifications.
 *   - runHealthCheck dedupes inside the cooldown window.
 *   - runHealthCheck re-alerts after the cooldown window expires.
 *   - runHealthCheck NEVER alerts on the health-check cron itself.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { superDb } from "@/lib/db";
import {
  withCronHeartbeat,
  evaluateCronHealth,
  runHealthCheck,
  REGISTERED_CRONS,
} from "@/lib/cron-health";
import { writeCronAuditOnAcumon } from "@/lib/cron-health/audit";

const TEN_MIN_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function ensureAcumonTenant() {
  const existing = await superDb.tenant.findUnique({ where: { slug: "acumon" } });
  if (existing) return existing;
  return superDb.tenant.create({
    data: {
      slug: "acumon",
      name: "Acumon (operator) — test",
    },
  });
}

async function ensureAcumonAdmin(tenantId: string) {
  const email = `cron-health-admin-${randomUUID().slice(0, 8)}@example.com`;
  const user = await superDb.user.create({ data: { email, name: "Cron health admin" } });
  return superDb.membership.create({
    data: {
      tenantId,
      userId: user.id,
      role: "FIRM_ADMIN",
      status: "ACTIVE",
    },
  });
}

async function clearHeartbeat(cronName: string) {
  await superDb.cronHeartbeat.deleteMany({ where: { cronName } });
}

describe("cron-health — withCronHeartbeat", () => {
  it("creates the heartbeat row + records success metadata on the happy path", async () => {
    await clearHeartbeat("lifecycle-sweep");

    const result = await withCronHeartbeat("lifecycle-sweep", async () => {
      // Tiny delay so lastDurationMs is non-zero.
      await new Promise((r) => setTimeout(r, 5));
      return { worked: true };
    });
    expect(result.worked).toBe(true);

    const row = await superDb.cronHeartbeat.findUnique({ where: { cronName: "lifecycle-sweep" } });
    expect(row).not.toBeNull();
    expect(row!.expectedIntervalMinutes).toBe(24 * 60);
    expect(row!.lastRunAt).not.toBeNull();
    expect(row!.lastSuccessAt).not.toBeNull();
    expect(row!.lastDurationMs).not.toBeNull();
    expect(row!.lastDurationMs!).toBeGreaterThanOrEqual(0);
    expect(row!.consecutiveFailures).toBe(0);
    expect(row!.lastErrorMessage).toBeNull();
  });

  it("records failure metadata + rethrows on the unhappy path", async () => {
    await clearHeartbeat("billing-close");

    const boom = new Error("kaboom");
    await expect(
      withCronHeartbeat("billing-close", async () => {
        throw boom;
      }),
    ).rejects.toThrow("kaboom");

    const row = await superDb.cronHeartbeat.findUnique({ where: { cronName: "billing-close" } });
    expect(row).not.toBeNull();
    expect(row!.lastFailureAt).not.toBeNull();
    expect(row!.lastErrorMessage).toBe("kaboom");
    expect(row!.consecutiveFailures).toBe(1);
    expect(row!.lastSuccessAt).toBeNull();
  });

  it("increments consecutiveFailures across multiple failures and resets on success", async () => {
    await clearHeartbeat("termination");

    for (let i = 0; i < 3; i++) {
      await expect(
        withCronHeartbeat("termination", async () => {
          throw new Error(`fail-${i}`);
        }),
      ).rejects.toThrow();
    }
    let row = await superDb.cronHeartbeat.findUnique({ where: { cronName: "termination" } });
    expect(row!.consecutiveFailures).toBe(3);

    await withCronHeartbeat("termination", async () => "ok");
    row = await superDb.cronHeartbeat.findUnique({ where: { cronName: "termination" } });
    expect(row!.consecutiveFailures).toBe(0);
    expect(row!.lastErrorMessage).toBeNull();
    expect(row!.lastSuccessAt).not.toBeNull();
  });

  it("refuses unknown cron names", async () => {
    await expect(withCronHeartbeat("not-a-real-cron", async () => 1)).rejects.toThrow(
      /unknown cron name/,
    );
  });

  it("truncates error messages to 500 chars", async () => {
    await clearHeartbeat("digest");
    const longMessage = "x".repeat(2000);
    await expect(
      withCronHeartbeat("digest", async () => {
        throw new Error(longMessage);
      }),
    ).rejects.toThrow();
    const row = await superDb.cronHeartbeat.findUnique({ where: { cronName: "digest" } });
    expect(row!.lastErrorMessage!.length).toBe(500);
  });
});

describe("cron-health — evaluateCronHealth", () => {
  it("reports never-run for every cron when the table is empty", async () => {
    // Clear all heartbeats so every cron is missing.
    await superDb.cronHeartbeat.deleteMany({});
    const statuses = await evaluateCronHealth();
    expect(statuses.length).toBe(REGISTERED_CRONS.length);
    for (const s of statuses) {
      expect(s.state).toBe("never-run");
      expect(s.lastSuccessAt).toBeNull();
    }
  });

  it("reports ok when lastSuccessAt is recent", async () => {
    await clearHeartbeat("webhooks-deliver");
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "webhooks-deliver",
        expectedIntervalMinutes: 1,
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
      },
    });
    const statuses = await evaluateCronHealth();
    const s = statuses.find((x) => x.cronName === "webhooks-deliver")!;
    expect(s.state).toBe("ok");
  });

  it("reports stalled when lastSuccessAt is older than 2× expected interval", async () => {
    await clearHeartbeat("lifecycle-sweep");
    // expectedInterval = 1440 min = 1 day. Stall threshold = 2 days.
    // Make the last success 3 days ago.
    const threeDaysAgo = new Date(Date.now() - 3 * ONE_DAY_MS);
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "lifecycle-sweep",
        expectedIntervalMinutes: 24 * 60,
        lastRunAt: threeDaysAgo,
        lastSuccessAt: threeDaysAgo,
        consecutiveFailures: 0,
      },
    });
    const statuses = await evaluateCronHealth();
    const s = statuses.find((x) => x.cronName === "lifecycle-sweep")!;
    expect(s.state).toBe("stalled");
  });

  it("reports failing when consecutiveFailures crosses the threshold even if recent success exists", async () => {
    await clearHeartbeat("digest");
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "digest",
        expectedIntervalMinutes: 7 * 24 * 60,
        lastRunAt: new Date(),
        lastSuccessAt: new Date(Date.now() - TEN_MIN_MS),
        consecutiveFailures: 3,
        lastFailureAt: new Date(),
        lastErrorMessage: "oops",
      },
    });
    const statuses = await evaluateCronHealth();
    const s = statuses.find((x) => x.cronName === "digest")!;
    expect(s.state).toBe("failing");
  });

  it("`now` injection lets us test from a stable point in time", async () => {
    await clearHeartbeat("webhooks-deliver");
    const t0 = new Date("2026-05-11T12:00:00Z");
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "webhooks-deliver",
        expectedIntervalMinutes: 1,
        lastRunAt: t0,
        lastSuccessAt: t0,
        consecutiveFailures: 0,
      },
    });
    // 30 seconds later: ok.
    const ok = await evaluateCronHealth(new Date(t0.getTime() + 30_000));
    expect(ok.find((s) => s.cronName === "webhooks-deliver")!.state).toBe("ok");
    // 3 minutes later: stalled (2× interval = 2 minutes).
    const stalled = await evaluateCronHealth(new Date(t0.getTime() + 3 * 60_000));
    expect(stalled.find((s) => s.cronName === "webhooks-deliver")!.state).toBe("stalled");
  });
});

describe("cron-health — runHealthCheck", () => {
  beforeAll(async () => {
    const acumon = await ensureAcumonTenant();
    // At least one ACTIVE FIRM_ADMIN so notifications have a recipient. We
    // don't strictly need the user to exist — the dispatcher just looks up
    // memberships — but we want to assert that the inbox row materialises.
    await ensureAcumonAdmin(acumon.id);
  });

  it("fires a CRON_STALLED audit event on the operator chain for a stalled cron", async () => {
    const acumon = await ensureAcumonTenant();
    await clearHeartbeat("lifecycle-sweep");
    const stalledAt = new Date(Date.now() - 3 * ONE_DAY_MS);
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "lifecycle-sweep",
        expectedIntervalMinutes: 24 * 60,
        lastRunAt: stalledAt,
        lastSuccessAt: stalledAt,
        consecutiveFailures: 0,
      },
    });

    const before = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "lifecycle-sweep" },
    });
    const result = await runHealthCheck();
    expect(result.alerts.find((a) => a.cronName === "lifecycle-sweep")).toBeDefined();
    const after = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "lifecycle-sweep" },
    });
    expect(after).toBe(before + 1);

    const row = await superDb.cronHeartbeat.findUnique({
      where: { cronName: "lifecycle-sweep" },
    });
    expect(row!.stalledNotifiedAt).not.toBeNull();
  });

  it("dedupes within the cooldown window (re-running immediately writes no second audit)", async () => {
    const acumon = await ensureAcumonTenant();
    await clearHeartbeat("billing-close");
    const stalledAt = new Date(Date.now() - 5 * ONE_DAY_MS);
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "billing-close",
        expectedIntervalMinutes: 24 * 60,
        lastRunAt: stalledAt,
        lastSuccessAt: stalledAt,
        consecutiveFailures: 0,
      },
    });

    await runHealthCheck();
    const afterFirst = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "billing-close" },
    });
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Run again immediately — should NOT re-fire because stalledNotifiedAt
    // was just bumped and the cooldown is `expectedIntervalMinutes`.
    const second = await runHealthCheck();
    expect(second.alerts.find((a) => a.cronName === "billing-close")).toBeUndefined();
    const afterSecond = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "billing-close" },
    });
    expect(afterSecond).toBe(afterFirst);
  });

  it("re-alerts after the cooldown window expires", async () => {
    const acumon = await ensureAcumonTenant();
    await clearHeartbeat("termination");
    // Stalled cron with stalledNotifiedAt > expectedInterval ago.
    const stalledAt = new Date(Date.now() - 5 * ONE_DAY_MS);
    const oldNotifiedAt = new Date(Date.now() - 2 * ONE_DAY_MS); // > 1 day cooldown
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "termination",
        expectedIntervalMinutes: 24 * 60,
        lastRunAt: stalledAt,
        lastSuccessAt: stalledAt,
        consecutiveFailures: 0,
        stalledNotifiedAt: oldNotifiedAt,
      },
    });

    const before = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "termination" },
    });
    const result = await runHealthCheck();
    expect(result.alerts.find((a) => a.cronName === "termination")).toBeDefined();
    const after = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED", subjectId: "termination" },
    });
    expect(after).toBe(before + 1);
  });

  it("never alerts on the health-check cron itself", async () => {
    const acumon = await ensureAcumonTenant();
    await clearHeartbeat("health-check");
    const stalledAt = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10 hours ago
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "health-check",
        expectedIntervalMinutes: 15,
        lastRunAt: stalledAt,
        lastSuccessAt: stalledAt,
        consecutiveFailures: 5,
      },
    });

    const result = await runHealthCheck();
    expect(result.alerts.find((a) => a.cronName === "health-check")).toBeUndefined();
    const cronStalledForHealthCheck = await superDb.auditEvent.count({
      where: {
        tenantId: acumon.id,
        eventType: "CRON_STALLED",
        subjectId: "health-check",
      },
    });
    expect(cronStalledForHealthCheck).toBe(0);
  });

  it("does NOT alert on never-run state (operator hasn't wired the schedule yet)", async () => {
    const acumon = await ensureAcumonTenant();
    // Wipe everything — no rows, every cron is "never-run".
    await superDb.cronHeartbeat.deleteMany({});
    const before = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED" },
    });
    const result = await runHealthCheck();
    expect(result.alerts.length).toBe(0);
    const after = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_STALLED" },
    });
    expect(after).toBe(before);
  });

  it("dispatches a notification + inbox row to Acumon FIRM_ADMIN on stall", async () => {
    const acumon = await ensureAcumonTenant();
    await clearHeartbeat("digest");
    const stalledAt = new Date(Date.now() - 30 * ONE_DAY_MS); // a month ago
    await superDb.cronHeartbeat.create({
      data: {
        cronName: "digest",
        expectedIntervalMinutes: 7 * 24 * 60,
        lastRunAt: stalledAt,
        lastSuccessAt: stalledAt,
        consecutiveFailures: 0,
      },
    });

    await runHealthCheck();
    const dispatches = await superDb.notificationDispatch.findMany({
      where: { tenantId: acumon.id, kind: "cron_stalled" },
    });
    // At least one FIRM_ADMIN was set up in beforeAll.
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect(dispatches.some((d) => d.dedupeKey.startsWith("digest:"))).toBe(true);

    const inbox = await superDb.notificationInbox.findMany({
      where: { tenantId: acumon.id, kind: "cron_stalled" },
    });
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });
});

describe("cron-health — writeCronAuditOnAcumon helper", () => {
  it("writes the audit row on the Acumon tenant chain", async () => {
    const acumon = await ensureAcumonTenant();
    const before = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_RUN_FAILED", subjectId: "test-cron" },
    });
    await writeCronAuditOnAcumon("CRON_RUN_FAILED", "test-cron", { hello: "world" });
    const after = await superDb.auditEvent.count({
      where: { tenantId: acumon.id, eventType: "CRON_RUN_FAILED", subjectId: "test-cron" },
    });
    expect(after).toBe(before + 1);
  });
});
