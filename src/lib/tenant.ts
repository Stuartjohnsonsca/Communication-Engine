import { auth } from "@/lib/auth";
import { superDb } from "@/lib/db";
import type { Membership, Tenant, User } from "@prisma/client";

export type TenantContext = {
  tenant: Tenant;
  membership: Membership;
  user: User;
};

/**
 * Resolves the active tenant context for a request from:
 *  1. NextAuth session (the user)
 *  2. The `[tenantSlug]` route segment
 *  3. The user's active Membership in that tenant
 *
 * Returns null if any check fails. Routes/pages should redirect to /login
 * (no session) or /403 (no membership).
 */
export async function getTenantContext(tenantSlug: string): Promise<TenantContext | null> {
  const session = await auth();
  if (!session?.user?.email) return null;

  const tenant = await superDb.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return null;

  const user = await superDb.user.findUnique({ where: { email: session.user.email } });
  if (!user) return null;

  const membership = await superDb.membership.findUnique({
    where: {
      tenantId_userId: { tenantId: tenant.id, userId: user.id },
    },
  });
  if (!membership || membership.status !== "ACTIVE") return null;

  return { tenant, membership, user };
}

export async function requireTenantContext(tenantSlug: string): Promise<TenantContext> {
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) throw new Error(`No tenant access: ${tenantSlug}`);
  return ctx;
}
