import { superDb } from "@/lib/db";

/**
 * Read helpers for /admin/audit's verification status card. Uses superDb
 * because the page handler has already enforced `audit:read` on the
 * tenant context — RLS is double-defence (the row's tenantId is set) but
 * not the primary gate. Same pattern as the rest of `src/lib/audit.ts`'s
 * read path.
 */

export async function latestVerificationForTenant(tenantId: string) {
  return superDb.auditChainVerification.findFirst({
    where: { tenantId },
    orderBy: { startedAt: "desc" },
  });
}

export async function recentVerificationsForTenant(tenantId: string, limit = 10) {
  return superDb.auditChainVerification.findMany({
    where: { tenantId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
