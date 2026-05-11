/**
 * Migration-history backfill (post-PRD opportunistic hardening).
 *
 * Coverage:
 *   - backfillMigrationHistory is a no-op when `_prisma_migrations`
 *     doesn't exist (fresh DB).
 *   - Renames every old single-digit migration name to its zero-padded
 *     equivalent and reports the rowCount.
 *   - Idempotent: a second run after rename updates zero rows.
 *   - Only touches the ten old names — does not corrupt already-zero-padded
 *     rows like `10_roadmap` or `43_subprocessor_changes`.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Client } from "pg";
import { backfillMigrationHistory } from "../../scripts/migrate-history-backfill";

const url = () => process.env.TEST_DATABASE_URL!;

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function ensurePrismaMigrationsTable() {
  await withClient(async (c) => {
    await c.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        id                      VARCHAR(36) PRIMARY KEY NOT NULL,
        checksum                VARCHAR(64) NOT NULL,
        finished_at             TIMESTAMPTZ,
        migration_name          VARCHAR(255) NOT NULL,
        logs                    TEXT,
        rolled_back_at          TIMESTAMPTZ,
        started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count     INTEGER NOT NULL DEFAULT 0
      );
    `);
  });
}

async function dropPrismaMigrationsTable() {
  await withClient((c) => c.query(`DROP TABLE IF EXISTS "_prisma_migrations"`));
}

async function snapshotPrismaMigrations(): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ migration_name: string }>(
      `SELECT migration_name FROM "_prisma_migrations"`,
    );
    return r.rows.map((row) => row.migration_name).sort();
  });
}

async function insertHistoryRow(name: string) {
  await withClient((c) =>
    c.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, applied_steps_count, finished_at)
       VALUES ($1, $2, $3, 1, now())`,
      [randomUUID(), randomUUID().replace(/-/g, ""), name],
    ),
  );
}

const OLD_NAMES = [
  "0_init",
  "1_fcg_change_propagation",
  "2_action_lifecycle",
  "3_draft_detail",
  "4_adherence",
  "5_sentiment",
  "6_meetings",
  "7_sales_identifier",
  "8_user_lifecycle",
  "9_billing",
] as const;

const NEW_NAMES = [
  "00_init",
  "01_fcg_change_propagation",
  "02_action_lifecycle",
  "03_draft_detail",
  "04_adherence",
  "05_sentiment",
  "06_meetings",
  "07_sales_identifier",
  "08_user_lifecycle",
  "09_billing",
] as const;

describe("migration-history backfill", () => {
  // The real test DB already has `_prisma_migrations` populated by
  // `migrate deploy` (post-rename, so the names are already the new
  // zero-padded ones). We tear it down to simulate fresh / partial
  // states, then restore the originals at the end of each test so
  // the rest of the suite still sees them.
  let originals: string[] = [];

  beforeAll(async () => {
    originals = await snapshotPrismaMigrations();
  });

  afterEach(async () => {
    await dropPrismaMigrationsTable();
    await ensurePrismaMigrationsTable();
    for (const name of originals) {
      await insertHistoryRow(name);
    }
  });

  it("is a no-op when _prisma_migrations doesn't exist", async () => {
    await dropPrismaMigrationsTable();
    const result = await backfillMigrationHistory(url());
    expect(result.skipped).toBe(true);
    expect(result.renamed).toBe(0);
  });

  it("renames every old single-digit name to its zero-padded equivalent", async () => {
    await dropPrismaMigrationsTable();
    await ensurePrismaMigrationsTable();
    for (const name of OLD_NAMES) {
      await insertHistoryRow(name);
    }
    const result = await backfillMigrationHistory(url());
    expect(result.skipped).toBe(false);
    expect(result.renamed).toBe(OLD_NAMES.length);
    const after = await snapshotPrismaMigrations();
    for (const n of NEW_NAMES) expect(after).toContain(n);
    for (const o of OLD_NAMES) expect(after).not.toContain(o);
  });

  it("is idempotent — running twice updates zero rows on the second pass", async () => {
    await dropPrismaMigrationsTable();
    await ensurePrismaMigrationsTable();
    for (const name of OLD_NAMES) {
      await insertHistoryRow(name);
    }
    const first = await backfillMigrationHistory(url());
    expect(first.renamed).toBe(OLD_NAMES.length);
    const second = await backfillMigrationHistory(url());
    expect(second.skipped).toBe(false);
    expect(second.renamed).toBe(0);
  });

  it("leaves already-zero-padded rows untouched", async () => {
    await dropPrismaMigrationsTable();
    await ensurePrismaMigrationsTable();
    const preserve = [
      "10_roadmap",
      "11_risks_register",
      "27_compliance_gate",
      "43_subprocessor_changes",
    ];
    for (const name of preserve) {
      await insertHistoryRow(name);
    }
    const result = await backfillMigrationHistory(url());
    expect(result.skipped).toBe(false);
    expect(result.renamed).toBe(0);
    const after = await snapshotPrismaMigrations();
    expect(after).toEqual(preserve.slice().sort());
  });

  it("handles a partial rename — only renames the rows that match", async () => {
    await dropPrismaMigrationsTable();
    await ensurePrismaMigrationsTable();
    await insertHistoryRow("0_init");
    await insertHistoryRow("05_sentiment");
    await insertHistoryRow("9_billing");
    await insertHistoryRow("10_roadmap");
    const result = await backfillMigrationHistory(url());
    expect(result.renamed).toBe(2);
    const after = await snapshotPrismaMigrations();
    expect(after).toContain("00_init");
    expect(after).toContain("05_sentiment");
    expect(after).toContain("09_billing");
    expect(after).toContain("10_roadmap");
    expect(after).not.toContain("0_init");
    expect(after).not.toContain("9_billing");
  });
});
