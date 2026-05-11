/**
 * Vitest globalSetup — runs once before any test file.
 *
 * Asserts TEST_DATABASE_URL is set and points at a Postgres we are willing
 * to wipe between runs. Repoints DATABASE_URL/DIRECT_URL to TEST_DATABASE_URL
 * so the rest of the app code (which reads DATABASE_URL via Prisma) hits the
 * test DB without further wiring.
 *
 * Does NOT run migrations — the surrounding harness (`npm run test:setup-db`
 * locally, the CI workflow on GH Actions) is responsible for applying the
 * schema + RLS once before the test pass starts. globalSetup only verifies
 * that the schema is present.
 */
import { Client } from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL not set. Run `npm run test:setup-db` first or set the env in CI.",
    );
  }
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  // Make tests deterministic — pin the audit hash seed so verify-chain has
  // a stable genesis regardless of host environment.
  process.env.AUDIT_HASH_SEED ??= "acumon-genesis-2026";
  // tenantDb (`src/lib/db.ts`) consults APP_DB_ROLE and, when set, does
  // `SET LOCAL ROLE` inside each tenant transaction so RLS evaluates
  // against a non-superuser context. setup-db.ts creates the matching
  // Postgres role and grants it to the connecting role. Without this the
  // rls-isolation tests can't verify isolation (superusers bypass RLS).
  process.env.APP_DB_ROLE ??= process.env.TEST_APP_DB_ROLE ?? "acumon_app";
  // Encryption keys: pin defaults so tests that exercise encrypt/decrypt
  // (TOTP, OAuth tokens, webhook secrets, API key HMAC) don't depend on
  // CI-side env wiring. The default ENCRYPTION_KEY is 32 random bytes
  // base64-encoded so the keys-registry length check passes; pinned to a
  // deterministic value for reproducible test hashes. NEXTAUTH_SECRET is
  // the v1 HMAC fallback used by `src/lib/auth/api-keys/secret.ts`.
  process.env.ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  process.env.NEXTAUTH_SECRET ??= "test-nextauth-secret";

  // Smoke-check that the schema is present and RLS is enabled. If migrate
  // deploy hasn't been run, fail fast with a friendlier error than a Prisma
  // 'relation does not exist' deep in a test.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN ('Tenant','Membership','AuditEvent')`,
    );
    if (tables.rows.length < 3) {
      throw new Error(
        "Test DB schema looks empty. Run `npm run test:setup-db` to apply migrations + RLS.",
      );
    }
    const memb = tables.rows.find((r) => r.relname === "Membership");
    if (!memb || !memb.relrowsecurity) {
      throw new Error(
        "Membership.RLS is not enabled. `prisma/rls.sql` must be applied — re-run `npm run test:setup-db`.",
      );
    }
  } finally {
    await client.end();
  }
}
