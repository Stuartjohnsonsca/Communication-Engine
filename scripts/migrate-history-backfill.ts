/**
 * Rewrites historical migration names in `_prisma_migrations` to their
 * zero-padded equivalents.
 *
 * Why: migration directories were originally named `0_init` ... `9_billing`
 * then `10_roadmap` etc. Lex sort puts `10_roadmap` before `2_action_lifecycle`,
 * so a fresh `prisma migrate deploy` against a clean DB tried to run later
 * migrations before their dependencies and failed. The directories were
 * renamed to `00_init` ... `09_billing` to fix lex order; this script
 * updates already-deployed environments so `_prisma_migrations` matches
 * the new directory names. Without it, the next `prisma migrate deploy`
 * would see ten "new" migrations (the renamed ones) and try to re-apply
 * them, which fails because the tables already exist.
 *
 * Idempotent: safe to run on a fresh DB (skips if `_prisma_migrations`
 * doesn't exist) and safe to re-run after rename (a second pass updates
 * zero rows). Always runs before `prisma migrate deploy` from the
 * `prisma:deploy` npm script.
 */
import { Client } from "pg";

const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["0_init", "00_init"],
  ["1_fcg_change_propagation", "01_fcg_change_propagation"],
  ["2_action_lifecycle", "02_action_lifecycle"],
  ["3_draft_detail", "03_draft_detail"],
  ["4_adherence", "04_adherence"],
  ["5_sentiment", "05_sentiment"],
  ["6_meetings", "06_meetings"],
  ["7_sales_identifier", "07_sales_identifier"],
  ["8_user_lifecycle", "08_user_lifecycle"],
  ["9_billing", "09_billing"],
];

export async function backfillMigrationHistory(connectionString: string): Promise<{
  skipped: boolean;
  renamed: number;
}> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tableExists = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
      ) AS exists;
    `);
    if (!tableExists.rows[0]?.exists) {
      return { skipped: true, renamed: 0 };
    }

    let renamed = 0;
    for (const [oldName, newName] of RENAMES) {
      const r = await client.query(
        `UPDATE _prisma_migrations SET migration_name = $1 WHERE migration_name = $2`,
        [newName, oldName],
      );
      if (r.rowCount && r.rowCount > 0) {
        renamed += r.rowCount;
      }
    }
    return { skipped: false, renamed };
  } finally {
    await client.end();
  }
}

async function main() {
  // Prefer DATABASE_URL; fall back to DIRECT_URL only if DATABASE_URL
  // is unset. (Pre-2026-05-17 this preferred DIRECT_URL — fine on
  // PgBouncer-fronted setups but on Railway it meant a broken
  // DIRECT_URL value crashed the backfill even when DATABASE_URL was
  // healthy. Reversed the priority.)
  const url = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!url) {
    console.log("DATABASE_URL / DIRECT_URL not set; skipping migration-history backfill.");
    return;
  }
  const { skipped, renamed } = await backfillMigrationHistory(url);
  if (skipped) {
    console.log("_prisma_migrations does not exist (fresh DB) — backfill is a no-op.");
    return;
  }
  if (renamed === 0) {
    console.log("Migration history already zero-padded — no rows updated.");
  } else {
    console.log(`Backfilled ${renamed} migration history row(s) to zero-padded names.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-history-backfill.ts")) {
  main().catch((err) => {
    console.error("migrate-history-backfill failed:", err);
    process.exit(1);
  });
}
