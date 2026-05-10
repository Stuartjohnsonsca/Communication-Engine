/**
 * One-shot DB initialiser for integration tests.
 *
 * Reads TEST_DATABASE_URL (falling back to DATABASE_URL only if explicitly
 * marked as a test database via TEST_DATABASE_ALLOW_PROD=1 — guard against
 * blowing away a real DB), runs `prisma migrate deploy` against it, then
 * applies prisma/rls.sql. Idempotent — safe to re-run.
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

  console.log("Running prisma migrate deploy against TEST_DATABASE_URL...");
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  console.log("Applying prisma/rls.sql...");
  const sql = readFileSync(join(process.cwd(), "prisma", "rls.sql"), "utf8");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }

  console.log("Test DB ready.");
}

main().catch((err) => {
  console.error("setup-db failed:", err);
  process.exit(1);
});
