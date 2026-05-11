/**
 * Database query observability (post-PRD hardening).
 *
 * Coverage:
 *   - env-driven threshold + statement_timeout helpers parse cleanly,
 *     fall back to defaults on garbage / negative / missing values, and
 *     clamp to safe bounds (100ms..10min).
 *   - countQueryParams handles Prisma's serialised params correctly,
 *     including malformed and missing inputs.
 *   - truncateQuery enforces the 500-char log cap.
 *   - The slow-query logger (installed once on the shared prisma singleton)
 *     emits a warn record above the env-driven threshold and stays silent
 *     below it. Raw param values never leak into the record (we log a
 *     paramCount, never the params).
 *   - tenantDb sets `SET LOCAL statement_timeout` per transaction and a
 *     query exceeding it is aborted with the Postgres canceling-statement
 *     error.
 *   - tenantDb honours an explicit `{ statementTimeoutMs }` override and
 *     clamps it to the lower bound.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  countQueryParams,
  clampStatementTimeoutMs,
  getSlowQueryThresholdMs,
  getTenantStatementTimeoutMs,
  truncateQuery,
} from "@/lib/db-observability";
import { superDb, tenantDb } from "@/lib/db";
import { setLogLevel, getLogLevel } from "@/lib/observability";

type Captured = { stream: "stdout" | "stderr"; line: string };

function captureStreams() {
  const captured: Captured[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    captured.push({ stream: "stdout", line: String(chunk) });
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    captured.push({ stream: "stderr", line: String(chunk) });
    return true;
  });
  return {
    captured,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

function parseRecords(captured: Captured[]): Array<{ stream: string; record: Record<string, unknown> }> {
  const out: Array<{ stream: string; record: Record<string, unknown> }> = [];
  for (const c of captured) {
    const trimmed = c.line.trimEnd();
    if (!trimmed) continue;
    try {
      out.push({ stream: c.stream, record: JSON.parse(trimmed) as Record<string, unknown> });
    } catch {
      // non-JSON lines (e.g. Prisma's own stdout) — ignore.
    }
  }
  return out;
}

describe("db-observability/env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("getSlowQueryThresholdMs returns default when env unset", () => {
    delete process.env.DB_SLOW_QUERY_MS;
    expect(getSlowQueryThresholdMs()).toBe(500);
  });

  it("getSlowQueryThresholdMs parses env override", () => {
    vi.stubEnv("DB_SLOW_QUERY_MS", "1000");
    expect(getSlowQueryThresholdMs()).toBe(1000);
  });

  it("getSlowQueryThresholdMs falls back to default on garbage env", () => {
    vi.stubEnv("DB_SLOW_QUERY_MS", "garbage");
    expect(getSlowQueryThresholdMs()).toBe(500);
  });

  it("getSlowQueryThresholdMs falls back to default on non-positive env", () => {
    vi.stubEnv("DB_SLOW_QUERY_MS", "-5");
    expect(getSlowQueryThresholdMs()).toBe(500);
    vi.stubEnv("DB_SLOW_QUERY_MS", "0");
    expect(getSlowQueryThresholdMs()).toBe(500);
  });

  it("getTenantStatementTimeoutMs returns default when env unset", () => {
    delete process.env.DB_TENANT_STATEMENT_TIMEOUT_MS;
    expect(getTenantStatementTimeoutMs()).toBe(15_000);
  });

  it("getTenantStatementTimeoutMs honours env override (clamped)", () => {
    vi.stubEnv("DB_TENANT_STATEMENT_TIMEOUT_MS", "2000");
    expect(getTenantStatementTimeoutMs()).toBe(2000);
  });

  it("clampStatementTimeoutMs enforces 100ms..10min bounds", () => {
    expect(clampStatementTimeoutMs(50)).toBe(100);
    expect(clampStatementTimeoutMs(60_000)).toBe(60_000);
    expect(clampStatementTimeoutMs(60 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(clampStatementTimeoutMs(-1)).toBe(15_000); // falls back to default
    expect(clampStatementTimeoutMs(Number.NaN)).toBe(15_000);
  });
});

describe("db-observability/pure helpers", () => {
  it("countQueryParams returns the array length from Prisma's serialised params", () => {
    expect(countQueryParams("[1,2,3]")).toBe(3);
    expect(countQueryParams("[]")).toBe(0);
    expect(countQueryParams('["a","b"]')).toBe(2);
  });

  it("countQueryParams returns 0 for null/undefined/garbage input", () => {
    expect(countQueryParams(undefined)).toBe(0);
    expect(countQueryParams(null)).toBe(0);
    expect(countQueryParams("not json")).toBe(0);
    expect(countQueryParams('{"a":1}')).toBe(0);
  });

  it("truncateQuery preserves short queries and caps long ones at 500 chars + ellipsis", () => {
    expect(truncateQuery("SELECT 1")).toBe("SELECT 1");
    const long = "X".repeat(600);
    const out = truncateQuery(long);
    expect(out.length).toBeLessThanOrEqual(501); // 500 + 1 for the ellipsis char
    expect(out.endsWith("…")).toBe(true);
  });
});

/**
 * The slow-query logger is installed once at module load on the shared
 * `prisma` singleton (see src/lib/db.ts). The handler reads the threshold
 * via getSlowQueryThresholdMs() per query event, so the test controls it
 * via DB_SLOW_QUERY_MS. We capture stdout/stderr to read the structured
 * JSON record the logger emits.
 */
describe("db-observability/slow query logger", () => {
  let levelBefore: ReturnType<typeof getLogLevel>;
  let nodeEnvBefore: string | undefined;
  let cap: ReturnType<typeof captureStreams>;

  beforeEach(() => {
    levelBefore = getLogLevel();
    nodeEnvBefore = process.env.NODE_ENV;
    // Force JSON log output for deterministic parsing.
    vi.stubEnv("NODE_ENV", "production");
    // Tight threshold so pg_sleep(0.2) reliably trips it.
    vi.stubEnv("DB_SLOW_QUERY_MS", "50");
    setLogLevel("debug");
    cap = captureStreams();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(levelBefore);
    if (nodeEnvBefore === undefined) vi.unstubAllEnvs();
    else {
      vi.stubEnv("NODE_ENV", nodeEnvBefore);
      vi.unstubAllEnvs();
    }
  });

  it("emits a warn-level structured record for slow queries", async () => {
    await superDb.$queryRawUnsafe("SELECT pg_sleep(0.2)");
    await new Promise((r) => setTimeout(r, 50));

    const slow = parseRecords(cap.captured)
      .map((r) => r.record)
      .find((r) => r.kind === "db-slow-query");
    expect(slow).toBeDefined();
    expect(slow!.level).toBe("warn");
    expect(slow!.msg).toBe("db slow query");
    expect(typeof slow!.durationMs).toBe("number");
    expect((slow!.durationMs as number) >= 50).toBe(true);
    expect(typeof slow!.query).toBe("string");
    expect(slow!.thresholdMs).toBe(50);
    expect(typeof slow!.paramCount).toBe("number");
    expect("params" in slow!).toBe(false);
  });

  it("does not log fast queries below the threshold", async () => {
    // Move threshold up so SELECT 1 is comfortably below it.
    vi.stubEnv("DB_SLOW_QUERY_MS", "5000");

    await superDb.$queryRawUnsafe("SELECT 1");
    await new Promise((r) => setTimeout(r, 50));

    const slow = parseRecords(cap.captured)
      .map((r) => r.record)
      .filter((r) => r.kind === "db-slow-query");
    expect(slow).toHaveLength(0);
  });

  it("never logs raw parameter values — only paramCount", async () => {
    const secret = "PII-EMAIL-THAT-MUST-NOT-LEAK@example.test";

    await superDb.$queryRawUnsafe(`SELECT pg_sleep(0.2), $1::text AS x`, secret);
    await new Promise((r) => setTimeout(r, 50));

    const allRaw = cap.captured.map((c) => c.line).join("\n");
    expect(allRaw).not.toContain(secret);

    const slow = parseRecords(cap.captured)
      .map((r) => r.record)
      .find((r) => r.kind === "db-slow-query");
    expect(slow).toBeDefined();
    expect(slow!.paramCount).toBe(1);
  });
});

describe("db-observability/tenantDb statement_timeout", () => {
  it("aborts a query that exceeds the per-tx statement_timeout", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `dbobs-${randomUUID().slice(0, 8)}`, name: "dbobs test" },
    });
    try {
      const db = tenantDb(tenant.id, { statementTimeoutMs: 200 });
      await expect(
        db.$queryRawUnsafe(`SELECT pg_sleep(2)`),
      ).rejects.toThrow(/canceling statement|statement timeout/i);
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("permits a query that completes within the per-tx statement_timeout", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `dbobs-${randomUUID().slice(0, 8)}`, name: "dbobs test" },
    });
    try {
      const db = tenantDb(tenant.id, { statementTimeoutMs: 2000 });
      const rows = await db.$queryRawUnsafe<Array<{ ok: number }>>(`SELECT 1 AS ok`);
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("clamps an explicit override below the minimum to 100ms", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `dbobs-${randomUUID().slice(0, 8)}`, name: "dbobs test" },
    });
    try {
      // Pass 10ms — clamped up to 100ms. pg_sleep(0.5) still well exceeds it.
      const db = tenantDb(tenant.id, { statementTimeoutMs: 10 });
      await expect(
        db.$queryRawUnsafe(`SELECT pg_sleep(0.5)`),
      ).rejects.toThrow(/canceling statement|statement timeout/i);
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } });
    }
  });
});
