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
