import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Integration test config.
 *
 * Tests share a real Postgres database (TEST_DATABASE_URL) and assert against
 * RLS, the audit-chain hash trigger, RBAC, and cron sweep idempotency. RLS
 * only fires against a real Postgres instance — mocks would let regressions
 * land silently. CI provisions the DB via the `postgres` service container in
 * .github/workflows/ci.yml; locally, point TEST_DATABASE_URL at any disposable
 * Postgres and run `npm run test:setup-db` once to apply the schema + RLS.
 *
 * Tests run sequentially in a single fork so transactions / GUC state from
 * one test cannot bleed into another. Each test uses a freshly-seeded tenant
 * (helpers/fixtures.ts) so they do not need cross-test cleanup.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
