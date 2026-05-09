// Runs `prisma/rls.sql` after `prisma migrate deploy`.
// Called from package.json `prisma:deploy` script and from the Railway start command.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL / DIRECT_URL not set; skipping RLS apply.");
    process.exit(0);
  }

  const sql = readFileSync(join(process.cwd(), "prisma", "rls.sql"), "utf8");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log("RLS + audit trigger applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("post-migrate failed:", err);
  process.exit(1);
});
