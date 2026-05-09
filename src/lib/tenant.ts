import { auth } from "@/lib/auth";
import { superDb } from "@/lib/db";
import type { Membership, Tenant, User } from "@prisma/client";

export type TenantContext = {
  tenant: Tenant;
  membership: Membership;
  user: User;
};

// PRD §15.2 needs "logged in within the billing month" — debounce the
// Membership.lastLoginAt write so a busy session doesn't hammer the DB while
// still giving us hour-grained activity for billing.
const LAST_LOGIN_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * Resolves the active tenant context for a request from:
 *  1. NextAuth session (the user)
 *  2. The `[tenantSlug]` route segment
 *  3. The user's active Membership in that tenant
 *
 * Returns null if any check fails. Routes/pages should redirect to /login
 * (no session) or /403 (no membership).
 *
 * Side-effect: stamps `Membership.lastLoginAt` (debounced) so the billing
 * engine can tell whether the User was active in a given month.
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

  void stampLastLoginIfStale(membership);

  return { tenant, membership, user };
}

async function stampLastLoginIfStale(m: Membership) {
  const now = Date.now();
  if (m.lastLoginAt && now - m.lastLoginAt.getTime() < LAST_LOGIN_DEBOUNCE_MS) return;
  try {
    await superDb.membership.update({
      where: { id: m.id },
      data: { lastLoginAt: new Date(now) },
    });
  } catch {
    // Non-fatal — billing falls back to draft activity if lastLoginAt is
    // stale. Don't block the request on a write race.
  }
}

export async function requireTenantContext(tenantSlug: string): Promise<TenantContext> {
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) throw new Error(`No tenant access: ${tenantSlug}`);
  return ctx;
}
