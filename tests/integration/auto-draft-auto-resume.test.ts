/**
 * Post-PRD hardening item 61 — auto-draft circuit-breaker auto-resume.
 *
 * Tests cover the four-corner eligibility matrix:
 *   - not paused                   → "not_paused"
 *   - paused by operator           → "skipped_not_eligible"
 *   - paused by locked sentinel    → "skipped_not_eligible"
 *   - paused < MIN_PAUSE_MINUTES   → "skipped_too_recent"
 *   - failures in resume window    → "skipped_still_failing"
 *   - clean + eligible             → "auto_resumed" + audit + notify
 *
 * Plus the thrash-lock interaction with the trip path:
 *   - trip with autoDraftAutoResumeAt within THRASH_WINDOW_MINUTES
 *     uses LOCKED_SENTINEL_ACTOR; subsequent auto-resume refuses.
 *   - operator manual resume clears autoDraftAutoResumeAt (clean
 *     slate for the next incident).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  evaluateAutoPauseCircuitBreaker,
  evaluateAutoResume,
  FAILURE_THRESHOLD,
  WINDOW_MINUTES,
  SENTINEL_ACTOR,
  LOCKED_SENTINEL_ACTOR,
  MIN_PAUSE_MINUTES,
  RESUME_WINDOW_MINUTES,
  THRASH_WINDOW_MINUTES,
} from "@/lib/drafts/circuit-breaker";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function pauseTenant(
  tenantId: string,
  opts: { byName: string; reason?: string; pausedAt?: Date },
) {
  await superDb.tenant.update({
    where: { id: tenantId },
    data: {
      autoDraftPausedAt: opts.pausedAt ?? new Date(),
      autoDraftPausedByName: opts.byName,
      autoDraftPauseReason: opts.reason ?? "test",
    },
  });
}

async function seedFailedAutoDraft(tenantId: string, createdAt?: Date) {
  return superDb.llmCall.create({
    data: {
      tenantId,
      role: "draft",
      context: "auto-draft",
      provider: "mock",
      model: "mock",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      succeeded: false,
      createdAt: createdAt ?? new Date(),
    },
  });
}

describe("auto-resume — eligibility", () => {
  it("returns not_paused when the tenant is not paused", async () => {
    const tenant = await createTestTenant();
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("not_paused");
  });

  it("refuses to resume an operator-paused tenant", async () => {
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: "Stuart",
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES + 10) * 60 * 1000),
    });
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("skipped_not_eligible");
    if (r.result === "skipped_not_eligible") {
      expect(r.pausedByName).toBe("Stuart");
    }
    const after = await superDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { autoDraftPausedAt: true },
    });
    expect(after!.autoDraftPausedAt).not.toBeNull();
  });

  it("refuses to resume a locked-sentinel pause", async () => {
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: LOCKED_SENTINEL_ACTOR,
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES + 10) * 60 * 1000),
    });
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("skipped_not_eligible");
    if (r.result === "skipped_not_eligible") {
      expect(r.pausedByName).toBe(LOCKED_SENTINEL_ACTOR);
    }
  });

  it("refuses to resume too soon after the pause", async () => {
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: SENTINEL_ACTOR,
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES - 2) * 60 * 1000),
    });
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("skipped_too_recent");
  });

  it("refuses to resume while failures are still in the window", async () => {
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: SENTINEL_ACTOR,
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES + 10) * 60 * 1000),
    });
    // A recent failure inside the resume window — must block resume.
    await seedFailedAutoDraft(tenant.id, new Date(Date.now() - 60 * 1000));
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("skipped_still_failing");
    if (r.result === "skipped_still_failing") {
      expect(r.recentFailures).toBe(1);
    }
  });

  it("resumes when sentinel is bare, paused long enough, and window is clean", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin"),
    });
    // Pause well outside MIN_PAUSE_MINUTES.
    const pausedAt = new Date(Date.now() - (MIN_PAUSE_MINUTES + 20) * 60 * 1000);
    await pauseTenant(tenant.id, { byName: SENTINEL_ACTOR, pausedAt });
    // Old failure aged out of the resume window.
    await seedFailedAutoDraft(
      tenant.id,
      new Date(Date.now() - (RESUME_WINDOW_MINUTES + 30) * 60 * 1000),
    );

    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("auto_resumed");

    const after = await superDb.tenant.findUnique({
      where: { id: tenant.id },
      select: {
        autoDraftPausedAt: true,
        autoDraftPausedByName: true,
        autoDraftPauseReason: true,
        autoDraftAutoResumeAt: true,
      },
    });
    expect(after!.autoDraftPausedAt).toBeNull();
    expect(after!.autoDraftPausedByName).toBeNull();
    expect(after!.autoDraftPauseReason).toBeNull();
    expect(after!.autoDraftAutoResumeAt).not.toBeNull();

    // Audit row with `autoResumed: true` payload.
    const audits = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id, eventType: "AUTO_DRAFT_RESUMED" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const payload = audits[0]!.payload as Record<string, unknown>;
    expect(payload.autoResumed).toBe(true);

    // Mandatory notification fanned out to FIRM_ADMIN.
    const dispatches = await superDb.notificationDispatch.findMany({
      where: { tenantId: tenant.id, kind: "auto_draft_auto_resumed" },
    });
    expect(dispatches.map((d) => d.membershipId)).toContain(admin.membership.id);
  });
});

describe("auto-resume — anti-thrash interaction with trip", () => {
  it("re-trip within THRASH_WINDOW_MINUTES of auto-resume uses LOCKED sentinel", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin"),
    });
    // Simulate a recent auto-resume just inside the thrash window.
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: {
        autoDraftAutoResumeAt: new Date(
          Date.now() - (THRASH_WINDOW_MINUTES - 30) * 60 * 1000,
        ),
      },
    });
    // Now seed enough failures to trip again.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedFailedAutoDraft(tenant.id);
    }
    const trip = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(trip.result).toBe("auto_paused");
    if (trip.result === "auto_paused") {
      expect(trip.threshLocked).toBe(true);
      expect(trip.pausedByName).toBe(LOCKED_SENTINEL_ACTOR);
    }

    // Auto-resume must REFUSE the locked sentinel even after the
    // pause is old enough and the failure window clears.
    // (We force-clear failures + age the pause to confirm refusal is
    // about the sentinel, not eligibility.)
    await superDb.llmCall.deleteMany({
      where: { tenantId: tenant.id, succeeded: false },
    });
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: {
        autoDraftPausedAt: new Date(
          Date.now() - (MIN_PAUSE_MINUTES + 10) * 60 * 1000,
        ),
      },
    });
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("skipped_not_eligible");
    if (r.result === "skipped_not_eligible") {
      expect(r.pausedByName).toBe(LOCKED_SENTINEL_ACTOR);
    }
  });

  it("re-trip OUTSIDE the thrash window uses the bare sentinel", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: {
        autoDraftAutoResumeAt: new Date(
          Date.now() - (THRASH_WINDOW_MINUTES + 60) * 60 * 1000,
        ),
      },
    });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedFailedAutoDraft(tenant.id);
    }
    const trip = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(trip.result).toBe("auto_paused");
    if (trip.result === "auto_paused") {
      expect(trip.threshLocked).toBe(false);
      expect(trip.pausedByName).toBe(SENTINEL_ACTOR);
    }
  });

  it("excludes failures outside the resume window even with bare sentinel", async () => {
    // Sanity: a stale failure that's older than the resume window must
    // not block resume. Mirrors the trip-window-edge test in item 59
    // but for the inverse direction.
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: SENTINEL_ACTOR,
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES + 10) * 60 * 1000),
    });
    await seedFailedAutoDraft(
      tenant.id,
      new Date(Date.now() - (RESUME_WINDOW_MINUTES + 5) * 60 * 1000),
    );
    const r = await evaluateAutoResume({ tenantId: tenant.id });
    expect(r.result).toBe("auto_resumed");
  });

  it("re-evaluating an auto-resumed tenant on the same tick is idempotent (not_paused)", async () => {
    const tenant = await createTestTenant();
    await pauseTenant(tenant.id, {
      byName: SENTINEL_ACTOR,
      pausedAt: new Date(Date.now() - (MIN_PAUSE_MINUTES + 5) * 60 * 1000),
    });
    const first = await evaluateAutoResume({ tenantId: tenant.id });
    expect(first.result).toBe("auto_resumed");
    const second = await evaluateAutoResume({ tenantId: tenant.id });
    expect(second.result).toBe("not_paused");
  });
});

describe("auto-resume — sanity on WINDOW_MINUTES export", () => {
  it("WINDOW_MINUTES is the bound the auto-resume rule rides", () => {
    // Item 61 design: the resume window matches the trip window so the
    // trip-count threshold naturally falls below FAILURE_THRESHOLD once
    // failures age out. If a future change splits these, the
    // hysteresis comment in `circuit-breaker.ts` needs to revisit.
    expect(RESUME_WINDOW_MINUTES).toBe(WINDOW_MINUTES);
  });
});
