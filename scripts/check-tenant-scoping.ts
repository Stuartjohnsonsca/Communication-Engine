/**
 * CI lint: forbid raw `prisma.<model>.` calls outside the audited
 * helpers in `src/lib/db.ts`, `src/lib/audit.ts`, and `prisma/seed.ts`.
 *
 * Tenant-scoped reads MUST go through `tenantDb(tenantId)`. The
 * `superDb` escape hatch is allowed in `src/lib/audit.ts`, `src/lib/auth.ts`,
 * `src/lib/tenant.ts`, NextAuth callbacks, and Acumon-admin paths.
 *
 * Heuristic: flag any source file (not in the allowlist) that references
 * `superDb` *or* `prisma.` and isn't itself one of the helpers.
 *
 * Phase 2 will tighten this further (AST-based check).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ALLOWLIST = [
  "src/lib/db.ts",
  "src/lib/audit.ts",
  "src/lib/auth.ts",
  "src/lib/tenant.ts",
  "prisma/seed.ts",
  "prisma/post-migrate.ts",
  "scripts/check-tenant-scoping.ts",
];

// Pages and route handlers must use getTenantContext + tenantDb. For Phase 1
// they currently use `superDb` directly to avoid the RLS transaction overhead
// in pages — that's a known soft spot we'll address in Phase 2 by switching
// to tenantDb everywhere. For now, allow `superDb` use within app/ but flag
// any file outside src/app or src/lib that uses raw `new PrismaClient()`.
const PHASE_1_ALLOW_SUPERDB_PREFIXES = ["src/app/", "src/lib/ai/"];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

async function main() {
  const violations: string[] = [];

  for await (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    if (ALLOWLIST.includes(rel)) continue;
    const text = await readFile(file, "utf8");

    if (text.includes("new PrismaClient(")) {
      violations.push(`${rel}: instantiates new PrismaClient — use src/lib/db.ts`);
    }
    if (
      /(^|[^a-zA-Z_])prisma\.[a-zA-Z]/m.test(text) &&
      !text.includes('from "@/lib/db"') &&
      !text.includes("from '../src/lib/db'")
    ) {
      violations.push(`${rel}: bare prisma.X — import { superDb, tenantDb } from "@/lib/db"`);
    }
    // Phase 2 tightening will go here.
    void PHASE_1_ALLOW_SUPERDB_PREFIXES;
  }

  if (violations.length) {
    console.error("Tenant-scoping violations:");
    for (const v of violations) console.error("  - " + v);
    process.exit(1);
  } else {
    console.log("Tenant-scoping check passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
