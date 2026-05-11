/**
 * Asserts every directory under `prisma/migrations/` is named with a
 * zero-padded 2-digit prefix (`NN_<slug>`), so `prisma migrate deploy`
 * against a fresh DB applies migrations in numeric order.
 *
 * Without this, lex sort puts e.g. `14_meeting_minutes` before `6_meetings`,
 * which causes fresh-deploy to fail on a missing-relation reference. CI
 * already enforces zero-padding via this check; future migrations must
 * pick the next 2-digit slot (`44_foo`, `45_foo`, ...).
 *
 * Run via `npm run check:migration-prefixes`.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");
const VALID = /^\d{2,}_[a-z0-9_]+$/;

function main(): never {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    console.error(`Could not read ${MIGRATIONS_DIR}:`, err);
    process.exit(2);
  }

  const offenders: string[] = [];
  let dirCount = 0;
  for (const name of entries) {
    const full = join(MIGRATIONS_DIR, name);
    if (!statSync(full).isDirectory()) continue;
    dirCount++;
    if (!VALID.test(name)) {
      offenders.push(name);
    }
  }

  if (offenders.length > 0) {
    console.error(
      `Found ${offenders.length} migration director${
        offenders.length === 1 ? "y" : "ies"
      } without a zero-padded 2-digit prefix:`,
    );
    for (const o of offenders) console.error(`  - ${o}`);
    console.error(
      "\nRename each so it matches /^\\d{2,}_[a-z0-9_]+$/ (e.g. `5_foo` -> `05_foo`).",
    );
    console.error(
      "If you renamed an already-deployed migration, scripts/migrate-history-backfill.ts must be updated to map the old name -> new name.",
    );
    process.exit(1);
  }

  console.log(`OK: all ${dirCount} migration director(y|ies) have zero-padded prefixes.`);
  process.exit(0);
}

main();
