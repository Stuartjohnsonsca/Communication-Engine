/**
 * One-shot DB initialiser for integration tests.
 *
 * Reads TEST_DATABASE_URL (falling back to DATABASE_URL only if explicitly
 * marked as a test database via TEST_DATABASE_ALLOW_PROD=1 — guard against
 * blowing away a real DB), syncs the schema via `prisma db push`, then
 * applies prisma/rls.sql. Idempotent — safe to re-run.
 *
 * Uses `db push` (not `migrate deploy`) because the migration directory
 * names are not zero-padded — lexicographic sort puts `14_meeting_minutes`
 * before `6_meetings`, so a fresh-DB `migrate deploy` fails with a missing-
 * relation error on migration 14 (which references `MeetingParticipant`
 * created in migration 6). `db push` reflects only the current
 * `schema.prisma` state, which is what tests care about. Production
 * Railway is unaffected — it migrates incrementally, and `_prisma_migrations`
 * already records every historical migration in its applied order.
 *
 * Used by:
 *   - CI: invoked from .github/workflows/ci.yml after the postgres service
 *     container becomes available.
 *   - Local: `npm run test:setup-db` once before `npm test`.
 */
import { execSync } from "node:child_process";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.error("TEST_DATABASE_URL not set. Refusing to run against DATABASE_URL.");
    process.exit(2);
  }

  // Refuse to run against any URL that doesn't look like a disposable test DB.
  // Heuristic: explicitly allow if the URL contains 'test' OR points at
  // localhost/127.0.0.1; otherwise require an explicit override.
  const allow =
    /test/i.test(url) ||
    /@localhost|@127\.0\.0\.1/i.test(url) ||
    process.env.TEST_DATABASE_ALLOW_PROD === "1";
  if (!allow) {
    console.error(
      "TEST_DATABASE_URL does not look like a test database (no 'test' in name and not localhost). " +
        "Set TEST_DATABASE_ALLOW_PROD=1 if this is intentional.",
    );
    process.exit(2);
  }

  console.log("Syncing schema to TEST_DATABASE_URL via prisma db push...");
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  console.log("Applying prisma/rls.sql...");
  const sql = readFileSync(join(process.cwd(), "prisma", "rls.sql"), "utf8");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);

    // Create a non-superuser app role so RLS actually fires when tests use
    // `tenantDb` (which does `SET LOCAL ROLE <APP_DB_ROLE>` inside its
    // transaction when the env var is set). Postgres superusers ALWAYS
    // bypass RLS — even with `FORCE ROW LEVEL SECURITY` — so without this
    // step the rls-isolation tests can't actually verify that the policy
    // blocks anything. The role is granted to the connecting role so the
    // SET LOCAL ROLE inside Prisma's transaction succeeds.
    const appRole = process.env.TEST_APP_DB_ROLE ?? "acumon_app";
    const me = (await client.query<{ current_user: string }>(`SELECT current_user`))
      .rows[0]!.current_user;
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
          CREATE ROLE ${appRole} NOSUPERUSER NOBYPASSRLS NOINHERIT;
        END IF;
      END $$;

      GRANT USAGE ON SCHEMA public TO ${appRole};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};
      GRANT ${appRole} TO "${me}";
    `);
    console.log(`Granted ${appRole} role (NOSUPERUSER NOBYPASSRLS) to current user.`);
  } finally {
    await client.end();
  }

  console.log("Test DB ready.");
}

main().catch((err) => {
  console.error("setup-db failed:", err);
  process.exit(1);
});
