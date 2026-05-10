/**
 * Coverage check: every model declared in `prisma/rls.sql`'s tenant_tables
 * array must be queryable via `tenantDb(tenantId).<model>.findMany()`.
 *
 * Two failure modes this catches:
 *   1. A new model gets added to RLS in rls.sql but has no Prisma delegate
 *      (typo in the array, schema drift) — the findMany call would error.
 *   2. A model is removed from rls.sql by accident — the assertion below
 *      will still pass (the test only checks RLS-listed models exist), so
 *      pair this with the Postgres relrowsecurity check that asserts the
 *      table actually has RLS enabled.
 *
 * For each table we query through `tenantDb` so any future RLS GUC bug
 * surfaces here too. We use a fresh tenant; result must be `[]` and must
 * not throw.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { tenantDb } from "@/lib/db";
import { createTestTenant } from "../helpers/fixtures";

/** Parse the tenant_tables ARRAY[…] block out of rls.sql. */
function readTenantTables(): string[] {
  const sql = readFileSync(join(process.cwd(), "prisma", "rls.sql"), "utf8");
  const match = sql.match(/tenant_tables\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*;/);
  if (!match) throw new Error("rls.sql: cannot find tenant_tables ARRAY[...]");
  return Array.from(match[1]!.matchAll(/'([A-Za-z]+)'/g)).map((m) => m[1]!);
}

/**
 * Map "PrismaModelName" (PascalCase, as in rls.sql) to the corresponding
 * delegate property on a Prisma client (camelCase). Prisma lowercases the
 * first letter; multi-cap prefixes ("DPIA", "FCG", "DSARequest", "UCG", etc.)
 * follow the same first-letter-only rule, so `dPIAAttestation`, `fCGRule`,
 * `dSARequest`, `uCGChatTurn`. Confirm against schema.prisma if a delegate
 * lookup fails.
 */
function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

describe("RLS tenant_tables coverage", () => {
  const tables = readTenantTables();

  it("rls.sql lists at least the core tenant-scoped models", () => {
    // Sanity check: parser worked and we got the load-bearing entries.
    expect(tables).toContain("Membership");
    expect(tables).toContain("AuditEvent");
    expect(tables).toContain("Draft");
    expect(tables).toContain("CommunicationAdherence");
  });

  it("every tenant_tables entry has a Prisma delegate reachable via tenantDb", async () => {
    const t = await createTestTenant();
    const db = tenantDb(t.id);
    const missing: string[] = [];
    for (const model of tables) {
      const key = delegateName(model);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delegate = (db as any)[key];
      if (!delegate || typeof delegate.findMany !== "function") {
        missing.push(`${model} (looked up as db.${key})`);
        continue;
      }
      // Call findMany with no args: RLS scopes to t.id, so the result must
      // be []. If the delegate name is right but RLS is mis-applied, this
      // could surface as either an error or unexpected rows; both fail the
      // test loudly.
      const rows = await delegate.findMany();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    }
    expect(missing, `models in rls.sql with no Prisma delegate: ${missing.join(", ")}`).toEqual([]);
  });

  it("every tenant_tables entry actually has RLS enabled in Postgres", async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const res = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND c.relname = ANY($1::text[])`,
        [tables],
      );
      const found = new Map(res.rows.map((r) => [r.relname, r]));
      const issues: string[] = [];
      for (const t of tables) {
        const r = found.get(t);
        if (!r) issues.push(`${t}: table missing in DB`);
        else if (!r.relrowsecurity) issues.push(`${t}: RLS not enabled`);
        else if (!r.relforcerowsecurity) issues.push(`${t}: RLS not FORCED`);
      }
      expect(issues, issues.join(" | ")).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
