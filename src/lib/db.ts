import { PrismaClient, type Prisma } from "@prisma/client";
import {
  clampStatementTimeoutMs,
  getTenantStatementTimeoutMs,
  installSlowQueryLogger,
} from "./db-observability";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function buildPrismaClient(): PrismaClient {
  const isDev = process.env.NODE_ENV === "development";
  // We use event-mode for the "query" channel so the slow-query logger can
  // pick up duration; warn/error stay on stdout so Prisma's own messages
  // still surface in dev logs.
  const client = new PrismaClient({
    log: isDev
      ? [
          { emit: "event", level: "query" },
          { emit: "stdout", level: "warn" },
          { emit: "stdout", level: "error" },
        ]
      : [
          { emit: "event", level: "query" },
          { emit: "stdout", level: "error" },
        ],
  });
  installSlowQueryLogger(client);
  return client;
}

export const prisma = global.__prisma ?? buildPrismaClient();

if (process.env.NODE_ENV !== "production") global.__prisma = prisma;

/**
 * Optional env-driven role switch inside each tenant transaction. When set,
 * the transaction `SET LOCAL ROLE`s to this role so RLS evaluates against a
 * non-superuser context — Postgres superusers always bypass RLS, even with
 * `FORCE ROW LEVEL SECURITY`. Used by the integration test suite (where the
 * connecting role is usually a superuser); production typically connects as
 * a non-superuser app role already and can leave this unset. Sanitised to
 * a strict Postgres-identifier shape so the raw SQL splice is safe.
 */
const TENANT_DB_ROLE = (() => {
  const raw = process.env.APP_DB_ROLE;
  if (!raw) return null;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw) ? raw : null;
})();

/**
 * Tenant-scoped Prisma client. Every query runs inside an interactive
 * transaction that first sets the `app.current_tenant` Postgres GUC,
 * which the RLS policies (see prisma/rls.sql) read.
 *
 * Usage:
 *   const db = tenantDb(tenantId);
 *   const fcg = await db.firmCultureGuide.findFirst({ where: { status: 'COMMITTED' } });
 *
 * Defence in depth: even if a query forgets `where: { tenantId }`, RLS
 * blocks rows from other tenants.
 *
 * Per-transaction `statement_timeout` is set before any tenant work runs —
 * a hung query can't pin a pool connection indefinitely. Override the
 * default (15s) with `{ statementTimeoutMs }` for cron sweeps or backfills
 * that legitimately need longer.
 */
export function tenantDb(tenantId: string, opts?: { statementTimeoutMs?: number }) {
  if (!tenantId) throw new Error("tenantDb: tenantId required");
  const stmtTimeoutMs = clampStatementTimeoutMs(
    opts?.statementTimeoutMs ?? getTenantStatementTimeoutMs(),
  );

  return prisma.$extends({
    name: "tenant-rls",
    query: {
      // `query(args)` (the default forward) re-issues the call on the
      // original prisma client and does NOT pick up the surrounding
      // `$transaction` context — so neither `set_config('app.current_tenant')`
      // nor `SET LOCAL ROLE` would apply to the actual query. We forward
      // through `tx[model][operation](args)` so the tx-local settings are
      // in scope when the SQL hits the DB. Verified empirically:
      //   - query(args) returned all rows (no role / config applied)
      //   - tx.model.operation(args) returned rows scoped to the policy.
      $allOperations: async ({ args, model, operation }) => {
        return prisma.$transaction(async (tx) => {
          // statement_timeout first: binds the ceiling before any other op,
          // including the set_config call below — protects against a hostile
          // GUC value from somehow triggering a hang.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${stmtTimeoutMs}`);
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_tenant', $1, true)`,
            tenantId,
          );
          if (TENANT_DB_ROLE) {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE "${TENANT_DB_ROLE}"`);
          }
          if (!model) {
            // Top-level operations (`$queryRaw`, `$executeRaw`, etc.) — call
            // straight on tx by name.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (tx as any)[operation](args);
          }
          const delegateKey = model.charAt(0).toLowerCase() + model.slice(1);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delegate = (tx as any)[delegateKey];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (delegate as any)[operation](args);
        });
      },
    },
  });
}

/**
 * `superDb` skips the tenant extension. Use ONLY in:
 *  - Acumon admin paths (cross-tenant analytics)
 *  - Cross-Client Learning curator pipelines
 *  - The audit-export job (reads its own tenant only — pass tenantDb instead)
 *  - NextAuth callbacks (pre-tenant-resolution)
 *
 * Every call must be reviewed and logged.
 */
export const superDb = prisma;

/**
 * Bounded-timeout wrapper for `superDb` work that would otherwise hold a
 * pool connection indefinitely on a hostile or pathological query plan.
 *
 * `tenantDb` (the request-time client) already sets `statement_timeout` per
 * transaction from item 29. `superDb` callers (cron sweeps, Acumon admin
 * paths, NextAuth callbacks) bypass that protection because they don't
 * wrap each call in a transaction. For the cron sweeps that issue
 * unbounded `deleteMany` / `updateMany` against potentially-huge tables,
 * a missing or bloated index could turn a routine reap into a pool stall.
 *
 * Usage — swap `superDb.X.op(args)` for `tx.X.op(args)` inside the
 * callback. The wrapper opens a Prisma interactive transaction, issues
 * `SET LOCAL statement_timeout`, then runs the callback. The fn's return
 * value bubbles out unchanged.
 *
 *   const { deleted } = await superDbWith({ statementTimeoutMs: 60_000 }, async (tx) => {
 *     const r = await tx.webhookDelivery.deleteMany({ where: { ... } });
 *     return { deleted: r.count };
 *   });
 *
 * Default timeout: 60s (more generous than the UI-request default of 15s
 * from `tenantDb` — cron sweeps legitimately take longer than UI clicks).
 * Override per call as needed; clamped to [100ms, 10min] per item 29.
 */
export async function superDbWith<T>(
  opts: { statementTimeoutMs?: number },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const stmtTimeoutMs = clampStatementTimeoutMs(
    opts.statementTimeoutMs ?? DEFAULT_SUPER_DB_STATEMENT_TIMEOUT_MS,
  );
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${stmtTimeoutMs}`);
    return fn(tx);
  });
}

const DEFAULT_SUPER_DB_STATEMENT_TIMEOUT_MS = 60_000;
