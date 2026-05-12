/**
 * Post-PRD hardening item 59 — auto-draft circuit breaker.
 *
 * Tests cover:
 *   - below-threshold failures → "healthy" outcome, no pause.
 *   - at/above-threshold failures → "auto_paused" outcome, tenant
 *     row pausedAt set, sentinel actor "(circuit-breaker)", reason
 *     contains the failure count.
 *   - successes inside the window do NOT reset the counter — the
 *     rule is "are recent attempts failing too often" not "are the
 *     last N consecutive."
 *   - already-paused tenants short-circuit with "already_paused"
 *     and don't double-pause / re-notify.
 *   - failures outside the window are excluded.
 *   - non-"auto-draft" context failures are excluded (a sentiment
 *     classification failure shouldn't trip the auto-draft breaker).
 *   - notifications dispatch one row per FIRM_ADMIN with the
 *     auto_draft_auto_paused kind.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  evaluateAutoPauseCircuitBreaker,
  FAILURE_THRESHOLD,
  WINDOW_MINUTES,
  SENTINEL_ACTOR,
} from "@/lib/drafts/circuit-breaker";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function seedLlmCall(opts: {
  tenantId: string;
  succeeded: boolean;
  context?: string;
  createdAt?: Date;
}) {
  return superDb.llmCall.create({
    data: {
      tenantId: opts.tenantId,
      role: "draft",
      context: opts.context ?? "auto-draft",
      provider: "mock",
      model: "mock",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      succeeded: opts.succeeded,
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

describe("circuit breaker — threshold + window", () => {
  it("stays healthy below the failure threshold", async () => {
    const tenant = await createTestTenant();
    // Threshold - 1 failures, all in window
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await seedLlmCall({ tenantId: tenant.id, succeeded: false });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("healthy");

    const after = await superDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { autoDraftPausedAt: true },
    });
    expect(after!.autoDraftPausedAt).toBeNull();
  });

  it("auto-pauses at the threshold and writes sentinel actor + audit event", async () => {
    const tenant = await createTestTenant();
    await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("admin"),
    });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({ tenantId: tenant.id, succeeded: false });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("auto_paused");
    if (r.result === "auto_paused") {
      expect(r.recentFailures).toBe(FAILURE_THRESHOLD);
      expect(r.windowMinutes).toBe(WINDOW_MINUTES);
    }

    const after = await superDb.tenant.findUnique({
      where: { id: tenant.id },
      select: {
        autoDraftPausedAt: true,
        autoDraftPausedByName: true,
        autoDraftPauseReason: true,
      },
    });
    expect(after!.autoDraftPausedAt).not.toBeNull();
    expect(after!.autoDraftPausedByName).toBe(SENTINEL_ACTOR);
    expect(after!.autoDraftPauseReason).toContain("Auto-paused after");

    // Audit event
    const events = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id, eventType: "AUTO_DRAFT_PAUSED" },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.actorMembershipId).toBeNull();
  });

  it("successes inside the window do NOT reset the failure count", async () => {
    const tenant = await createTestTenant();
    // 5 failures interspersed with 5 successes; rule is "failures in window," not "consecutive."
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({ tenantId: tenant.id, succeeded: false });
      await seedLlmCall({ tenantId: tenant.id, succeeded: true });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("auto_paused");
  });

  it("excludes failures outside the window", async () => {
    const tenant = await createTestTenant();
    const outsideWindow = new Date(
      Date.now() - (WINDOW_MINUTES + 5) * 60 * 1000,
    );
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({
        tenantId: tenant.id,
        succeeded: false,
        createdAt: outsideWindow,
      });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("healthy");
  });

  it("excludes non-auto-draft contexts", async () => {
    const tenant = await createTestTenant();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({
        tenantId: tenant.id,
        succeeded: false,
        context: "sentiment-classify",
      });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("healthy");
  });
});

describe("circuit breaker — idempotency", () => {
  it("returns already_paused when the tenant is already paused", async () => {
    const tenant = await createTestTenant();
    await superDb.tenant.update({
      where: { id: tenant.id },
      data: {
        autoDraftPausedAt: new Date(),
        autoDraftPausedByName: "Stuart",
      },
    });
    // Even with threshold failures, breaker must not re-pause.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({ tenantId: tenant.id, succeeded: false });
    }
    const r = await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });
    expect(r.result).toBe("already_paused");

    const after = await superDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { autoDraftPausedByName: true },
    });
    // Original actor preserved — circuit-breaker must not overwrite an
    // operator-initiated pause with the sentinel.
    expect(after!.autoDraftPausedByName).toBe("Stuart");
  });
});

describe("circuit breaker — notifications", () => {
  it("dispatches auto_draft_auto_paused to every FIRM_ADMIN", async () => {
    const tenant = await createTestTenant();
    const a1 = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("a1"),
    });
    const a2 = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("a2"),
    });
    // A non-admin must not be notified
    await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("u"),
    });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await seedLlmCall({ tenantId: tenant.id, succeeded: false });
    }
    await evaluateAutoPauseCircuitBreaker({ tenantId: tenant.id });

    const dispatches = await superDb.notificationDispatch.findMany({
      where: { tenantId: tenant.id, kind: "auto_draft_auto_paused" },
    });
    const notifiedIds = dispatches.map((d) => d.membershipId).sort();
    expect(notifiedIds).toEqual([a1.membership.id, a2.membership.id].sort());
  });
});
