import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { superDb } from "@/lib/db";

/**
 * Fixture helpers for integration tests. Each test that needs a tenant
 * calls `createTestTenant()` to get an isolated set of DB rows. Slugs are
 * uuid-suffixed so parallel test files (or re-runs without a teardown)
 * cannot collide.
 *
 * We deliberately skip an after-all truncate: tests assert against their
 * own tenant ids, and CI starts from a fresh ephemeral Postgres each run.
 * Locally, drop the test DB if rows accumulate.
 */

let counter = 0;

export function uniqueSlug(prefix = "tenant") {
  // Slugs must be valid Postgres identifiers in some legacy paths; keep
  // them lowercase + dash-separated.
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

export type TestTenantOpts = {
  slug?: string;
  name?: string;
};

export async function createTestTenant(opts: TestTenantOpts = {}) {
  const slug = opts.slug ?? uniqueSlug();
  return superDb.tenant.create({
    data: {
      slug,
      name: opts.name ?? slug,
    },
  });
}

export type TestUserOpts = {
  email?: string;
  name?: string | null;
  role?: Role;
};

export async function createTestUserAndMembership(
  tenantId: string,
  opts: TestUserOpts = {},
) {
  const email = opts.email ?? `${randomUUID().slice(0, 8)}@example.com`;
  const user = await superDb.user.create({
    data: {
      email,
      name: opts.name ?? null,
    },
  });
  const membership = await superDb.membership.create({
    data: {
      tenantId,
      userId: user.id,
      role: opts.role ?? "USER",
      status: "ACTIVE",
    },
  });
  return { user, membership };
}
