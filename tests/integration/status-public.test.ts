/**
 * Public /status surface — backlog item 9.
 *
 * The page is unauthenticated and lives outside the tenant slug, so the
 * load-bearing invariants are:
 *
 *   1. SLA aggregation uses cross-tenant SlaMeasurement rows but emits
 *      *aggregate* numbers only — no tenant identity is reachable from
 *      the public payload.
 *   2. Recent BreachIncidents are returned redacted: descriptions strip
 *      bracketed [tenant: <slug>] fragments; affectedClientCount is the
 *      only customer-side number that surfaces; the BreachClientNotification
 *      table is never read.
 *   3. Sub-processors and Accessibility statement come through unchanged
 *      (those rows are already public-by-design under §15.3 / §13.4).
 *   4. Terms versioning summary exposes only the maximum version number
 *      per kind across all tenants — never a tenant id, never a body.
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification, addAffectedTenant, createBreachIncident } from "@/lib/compliance/breach";
import { recordTerms } from "@/lib/terms";
import { getPublicStatus } from "@/lib/status";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

describe("public /status surface", () => {
  it("aggregates SLA measurements across tenants without leaking tenant identity", async () => {
    const target = await superDb.slaTarget.upsert({
      where: { code: "test-availability" },
      create: {
        code: "test-availability",
        ordinal: 9_000,
        name: "Test availability",
        kind: "AVAILABILITY",
        threshold: 99,
        unit: "%",
        aggregation: "monthly_pct",
        scope: "test",
        notes: null,
        isActive: true,
      },
      update: { isActive: true },
    });

    const a = await createTestTenant();
    const b = await createTestTenant();
    const period = currentPeriod();

    await superDb.slaMeasurement.create({
      data: {
        tenantId: a.id,
        targetId: target.id,
        period,
        observed: 99.95,
        outcome: "MET",
        sampleN: 720,
        recordedAt: new Date(),
        recordedByName: "fixture",
      },
    });
    await superDb.slaMeasurement.create({
      data: {
        tenantId: b.id,
        targetId: target.id,
        period,
        observed: 98.5,
        outcome: "MISSED",
        sampleN: 720,
        recordedAt: new Date(),
        recordedByName: "fixture",
      },
    });

    const status = await getPublicStatus();
    const row = status.sla.find((r) => r.target.code === "test-availability");
    expect(row).toBeDefined();
    expect(row!.period).toBe(period);
    expect(row!.tenantsMeasured).toBe(2);
    expect(row!.met).toBe(1);
    expect(row!.missed).toBe(1);
    expect(row!.sampleN).toBe(1440);
    // Sample-weighted mean of 99.95 + 98.5 (equal weights) ≈ 99.225
    expect(row!.aggregateObserved).toBeGreaterThan(99.2);
    expect(row!.aggregateObserved).toBeLessThan(99.3);

    // The shape MUST NOT have a tenantId or any tenant slug on it.
    const json = JSON.stringify(row);
    expect(json).not.toContain(a.id);
    expect(json).not.toContain(b.id);
    expect(json).not.toContain(a.slug);
    expect(json).not.toContain(b.slug);

    await superDb.slaMeasurement.deleteMany({ where: { targetId: target.id } });
    await superDb.slaTarget.update({
      where: { id: target.id },
      data: { isActive: false },
    });
  });

  it("aggregates LATENCY targets as median-of-tenant-medians", async () => {
    const target = await superDb.slaTarget.upsert({
      where: { code: "test-latency" },
      create: {
        code: "test-latency",
        ordinal: 9_001,
        name: "Test latency",
        kind: "LATENCY",
        threshold: 5,
        unit: "s",
        aggregation: "median",
        scope: "test",
        notes: null,
        isActive: true,
      },
      update: { isActive: true },
    });

    const tenants = await Promise.all([createTestTenant(), createTestTenant(), createTestTenant()]);
    const period = currentPeriod();
    // Per-tenant medians 2.0, 4.0, 12.0 → median-of-medians 4.0 (clears 5s threshold)
    const observations = [2.0, 4.0, 12.0];
    for (let i = 0; i < tenants.length; i++) {
      await superDb.slaMeasurement.create({
        data: {
          tenantId: tenants[i]!.id,
          targetId: target.id,
          period,
          observed: observations[i]!,
          outcome: observations[i]! <= 5 ? "MET" : "MISSED",
          sampleN: 100,
          recordedAt: new Date(),
          recordedByName: "fixture",
        },
      });
    }

    const status = await getPublicStatus();
    const row = status.sla.find((r) => r.target.code === "test-latency");
    expect(row).toBeDefined();
    expect(row!.aggregateObserved).toBe(4.0);
    expect(row!.aggregateOutcome).toBe("MET");

    await superDb.slaMeasurement.deleteMany({ where: { targetId: target.id } });
    await superDb.slaTarget.update({
      where: { id: target.id },
      data: { isActive: false },
    });
  });

  it("redacts BreachIncident descriptions and never exposes per-tenant notifications", async () => {
    const operatorTenant = await createTestTenant();
    const { membership: opMember } = await createTestUserAndMembership(operatorTenant.id, {
      role: "FIRM_ADMIN",
    });
    const affectedTenant = await createTestTenant({ slug: `affected-${Date.now()}` });
    const { membership: affMember } = await createTestUserAndMembership(affectedTenant.id, {
      role: "FIRM_ADMIN",
    });

    const incident = await createBreachIncident({
      title: "Status-test incident",
      description: `Status-test description with [tenant: ${affectedTenant.slug}] embedded — should be scrubbed.`,
      severity: "HIGH",
      awareAt: new Date(Date.now() - 3 * 3_600_000),
      affectedCategories: ["drafts", "audit metadata"],
      recordedByName: "fixture-operator",
      actorTenantId: operatorTenant.id,
      actorMembershipId: opMember.id,
    });
    const notification = await addAffectedTenant({
      incidentId: incident.id,
      tenantId: affectedTenant.id,
      actorTenantId: operatorTenant.id,
      actorMembershipId: opMember.id,
    });
    await dispatchNotification({
      notificationId: notification.id,
      tenantId: affectedTenant.id,
      notifiedByName: "fixture-operator",
      notifiedToName: "Fixture Affected Admin",
      notifiedToRole: "FIRM_ADMIN",
      payload: `Confidential body referencing tenant:${affectedTenant.slug}`,
      actorTenantId: operatorTenant.id,
      actorMembershipId: opMember.id,
    });
    void affMember; // referenced to keep TypeScript honest about unused-vars

    const status = await getPublicStatus();
    const found = status.incidents.find((i) => i.code === incident.code);
    expect(found).toBeDefined();
    expect(found!.affectedClientCount).toBe(1);
    expect(found!.description).not.toContain(affectedTenant.slug);
    expect(found!.description).toContain("[tenant redacted]");

    // The notification body — which is per-tenant + may carry sensitive
    // case detail — must never appear on the public payload.
    const json = JSON.stringify(status.incidents);
    expect(json).not.toContain(affectedTenant.slug);
    expect(json).not.toContain("Confidential body");
    expect(json).not.toContain("Fixture Affected Admin");
  });

  it("returns active sub-processors and exposes no tenant data on terms", async () => {
    const sp = await superDb.subProcessor.upsert({
      where: { code: "status-test-sp" },
      create: {
        code: "status-test-sp",
        ordinal: 9_002,
        name: "Status Test SP",
        role: "Status test sub-processor",
        jurisdiction: "UK",
        dataCategories: ["test-only"],
        isActive: true,
        addedAt: new Date(),
      },
      update: { isActive: true },
    });

    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
    });
    const recorded = await recordTerms({
      tenantId: tenant.id,
      kind: "MSA",
      documentRef: "fixture/contracts/msa-v1.pdf",
      body: `This MSA references tenant slug ${tenant.slug} and must NOT appear on /status.`,
      activate: false,
      actorMembershipId: membership.id,
    });

    const status = await getPublicStatus();
    expect(status.subProcessors.some((s) => s.code === sp.code)).toBe(true);
    const msa = status.terms.find((t) => t.kind === "MSA");
    expect(msa).toBeDefined();
    expect(msa!.latestVersion).toBeGreaterThanOrEqual(recorded.version);

    // The terms summary is version-only — body must never leak.
    const json = JSON.stringify(status.terms);
    expect(json).not.toContain(tenant.slug);
    expect(json).not.toContain("must NOT appear");

    await superDb.subProcessor.update({
      where: { id: sp.id },
      data: { isActive: false },
    });
  });

  it("includes the most recent published accessibility statement", async () => {
    // The statement is global and seeded; if a fresh DB has none, this
    // assertion just confirms the read returned null gracefully.
    const status = await getPublicStatus();
    if (status.accessibility) {
      expect(status.accessibility.isActive).toBe(true);
      expect(status.accessibility.body.length).toBeGreaterThan(0);
    } else {
      expect(status.accessibility).toBeNull();
    }

    // Suppress the unused-import warning when no audit events are written
    // by this test path.
    void writeAuditEvent;
  });
});

describe("public /status SLA trend", () => {
  it("returns a 6-period recentPeriods array oldest→newest with the right MET/MISSED outcomes", async () => {
    const target = await superDb.slaTarget.upsert({
      where: { code: "test-trend" },
      create: {
        code: "test-trend",
        ordinal: 9_001,
        name: "Test trend availability",
        kind: "AVAILABILITY",
        threshold: 99,
        unit: "%",
        aggregation: "monthly_pct",
        scope: "test",
        notes: null,
        isActive: true,
      },
      update: { isActive: true },
    });
    const t = await createTestTenant();
    // Seed 3 periods: 2 ago MET, 1 ago MISSED, current MET.
    const periods = lastNPeriodsDescending(6);
    const current = periods[0]!;
    const oneAgo = periods[1]!;
    const twoAgo = periods[2]!;

    const seedRows: Array<{
      period: string;
      observed: number;
      outcome: "MET" | "MISSED";
    }> = [
      { period: twoAgo, observed: 99.9, outcome: "MET" },
      { period: oneAgo, observed: 98.5, outcome: "MISSED" },
      { period: current, observed: 99.95, outcome: "MET" },
    ];
    for (const seed of seedRows) {
      await superDb.slaMeasurement.create({
        data: {
          tenantId: t.id,
          targetId: target.id,
          period: seed.period,
          observed: seed.observed,
          outcome: seed.outcome,
          sampleN: 720,
          recordedAt: new Date(),
          recordedByName: "fixture",
        },
      });
    }

    const status = await getPublicStatus();
    const row = status.sla.find((r) => r.target.code === "test-trend")!;
    expect(row.recentPeriods).toHaveLength(6);

    // Oldest first, newest last.
    expect(row.recentPeriods[0]!.period < row.recentPeriods[5]!.period).toBe(true);

    const byPeriod = new Map(row.recentPeriods.map((p) => [p.period, p]));
    expect(byPeriod.get(twoAgo)?.outcome).toBe("MET");
    expect(byPeriod.get(oneAgo)?.outcome).toBe("MISSED");
    expect(byPeriod.get(current)?.outcome).toBe("MET");

    // Periods with no measurement become INSUFFICIENT_DATA, NOT missing.
    const fourAgo = periods[4]!;
    expect(byPeriod.get(fourAgo)?.outcome).toBe("INSUFFICIENT_DATA");

    // Trend doesn't leak tenant identity.
    const json = JSON.stringify(row.recentPeriods);
    expect(json).not.toContain(t.id);
    expect(json).not.toContain(t.slug);

    await superDb.slaMeasurement.deleteMany({ where: { targetId: target.id } });
    await superDb.slaTarget.update({ where: { id: target.id }, data: { isActive: false } });
  });

  it("returns a stable-length trend of INSUFFICIENT_DATA when a target has no measurements", async () => {
    const target = await superDb.slaTarget.upsert({
      where: { code: "test-trend-empty" },
      create: {
        code: "test-trend-empty",
        ordinal: 9_002,
        name: "Test empty trend",
        kind: "LATENCY",
        threshold: 5,
        unit: "s",
        aggregation: "median",
        scope: "test",
        notes: null,
        isActive: true,
      },
      update: { isActive: true },
    });
    try {
      const status = await getPublicStatus();
      const row = status.sla.find((r) => r.target.code === "test-trend-empty")!;
      expect(row.recentPeriods).toHaveLength(6);
      expect(row.recentPeriods.every((p) => p.outcome === "INSUFFICIENT_DATA")).toBe(true);
      expect(row.recentPeriods.every((p) => p.observed === null)).toBe(true);
    } finally {
      await superDb.slaTarget.update({ where: { id: target.id }, data: { isActive: false } });
    }
  });
});

function lastNPeriodsDescending(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
