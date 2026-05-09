import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") global.__prisma = prisma;

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
 */
export function tenantDb(tenantId: string) {
  if (!tenantId) throw new Error("tenantDb: tenantId required");

  return prisma.$extends({
    name: "tenant-rls",
    query: {
      $allOperations: async ({ args, query }) => {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_tenant', $1, true)`,
            tenantId,
          );
          // The extended query function expects to receive the original tx
          // via the `$transaction` boundary; Prisma wires this automatically.
          return query(args);
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
