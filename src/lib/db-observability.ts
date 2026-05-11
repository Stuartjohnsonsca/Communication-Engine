/**
 * Database query observability (post-PRD hardening).
 *
 * Two concerns:
 *   1. SLOW-QUERY LOGGING — Prisma emits a `query` event for every SQL it
 *      issues, carrying the duration in ms. We subscribe once at client
 *      construction and emit a structured warn-level record via the
 *      observability logger when duration >= threshold. This lets the
 *      operator triage runaway queries via Railway logs / any downstream
 *      collector without enabling Prisma's noisy debug-log mode.
 *
 *   2. PER-TRANSACTION STATEMENT TIMEOUT — `tenantDb` wraps every operation
 *      in an interactive transaction. We set `SET LOCAL statement_timeout`
 *      inside that transaction so a hung query can't pin a pool connection
 *      indefinitely. UI-request defaults are tight (15s); long-running cron
 *      sweeps that legitimately need more time pass an explicit override.
 *
 * Sanitisation: we deliberately do NOT log raw query parameters. Prisma's
 * QueryEvent.params field is a JSON-stringified array of bind values, often
 * containing PII (email addresses, message bodies, etc.). We record the
 * COUNT of params so an operator can correlate to the offending query
 * without leaking the data.
 *
 * Failure mode: the `$on("query")` handler must never throw — Prisma traps
 * handler errors but a thrown handler still adds a tick of overhead per
 * query. We guard with a try/catch so a downstream logger failure does not
 * affect query performance.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { log } from "@/lib/observability";

const DEFAULT_SLOW_QUERY_MS = 500;
const DEFAULT_TENANT_STATEMENT_TIMEOUT_MS = 15_000;
const MIN_STATEMENT_TIMEOUT_MS = 100;
const MAX_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_QUERY_LOG_CHARS = 500;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function getSlowQueryThresholdMs(): number {
  return parsePositiveInt(process.env.DB_SLOW_QUERY_MS, DEFAULT_SLOW_QUERY_MS);
}

export function getTenantStatementTimeoutMs(): number {
  const n = parsePositiveInt(
    process.env.DB_TENANT_STATEMENT_TIMEOUT_MS,
    DEFAULT_TENANT_STATEMENT_TIMEOUT_MS,
  );
  return clampStatementTimeoutMs(n);
}

export function clampStatementTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TENANT_STATEMENT_TIMEOUT_MS;
  if (ms < MIN_STATEMENT_TIMEOUT_MS) return MIN_STATEMENT_TIMEOUT_MS;
  if (ms > MAX_STATEMENT_TIMEOUT_MS) return MAX_STATEMENT_TIMEOUT_MS;
  return Math.floor(ms);
}

export function countQueryParams(params: string | undefined | null): number {
  if (!params) return 0;
  try {
    const parsed = JSON.parse(params);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function truncateQuery(sql: string): string {
  if (sql.length <= MAX_QUERY_LOG_CHARS) return sql;
  return sql.slice(0, MAX_QUERY_LOG_CHARS) + "…";
}

const INSTALLED = new WeakSet<object>();

export function installSlowQueryLogger(
  client: PrismaClient,
  opts?: { thresholdMs?: number },
): void {
  if (INSTALLED.has(client)) return;
  INSTALLED.add(client);
  const explicitThreshold = opts?.thresholdMs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAny = (client as any).$on?.bind(client);
  if (typeof onAny !== "function") return;
  onAny("query", (e: Prisma.QueryEvent) => {
    try {
      const threshold = explicitThreshold ?? getSlowQueryThresholdMs();
      if (e.duration < threshold) return;
      log.warn("db slow query", {
        kind: "db-slow-query",
        durationMs: e.duration,
        thresholdMs: threshold,
        query: truncateQuery(e.query),
        paramCount: countQueryParams(e.params),
        target: e.target,
      });
    } catch {
      // Never let the observability hook itself cause a query failure.
    }
  });
}
