-- Sign-off questions become tenant-scoped (PRD §18 fixed posture). The
-- previous migration (12_signoff_questions) modelled them as a global
-- product-level register on the same pattern as Roadmap (§16) and Risks
-- (§17). That was wrong: §16 and §17 are §15.3 transparency surfaces
-- (single product roadmap, single product risks register, published to
-- every Client read-only), but §18 is each Client's own governance — they
-- decide their own retention period, quorum default, pricing position,
-- WhatsApp posture, etc. Two Clients on the same product instance must
-- not see each other's answers.
--
-- This migration:
--   1. Drops the ten globally-seeded rows from migration 12 (they were the
--      single shared copy);
--   2. Adds a NOT NULL `tenantId` foreign key with ON DELETE CASCADE so a
--      tenant termination cleans up its sign-off records;
--   3. Replaces the `code`-only unique constraint with a composite unique
--      on `(tenantId, code)` so each tenant has its own Q-01..Q-10;
--   4. Adds a `tenantId` index for the standard tenant-scoped query path.
--
-- RLS: a sibling change in `prisma/rls.sql` adds `SignOffQuestion` to the
-- tenant_tables array, so the per-transaction `app.current_tenant` GUC
-- enforces row-level isolation as defence in depth on top of WHERE clauses.
--
-- Seeding is done lazily by the application on first read for a tenant
-- (see `src/lib/signoff/index.ts`). Doing it here would require knowing
-- every existing tenant's id at migration time, and would also bake the
-- seed into the schema migration, making it harder to revise the canonical
-- question list later.

-- Drop globally-seeded rows from migration 12. Any operator decisions
-- recorded against the global rows were transient (the page only just
-- shipped) and there's no safe way to attribute them to a tenant after
-- the fact, so we delete rather than try to migrate them.
DELETE FROM "SignOffQuestion";

ALTER TABLE "SignOffQuestion"
  ADD COLUMN "tenantId" TEXT NOT NULL
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "SignOffQuestion_code_key";

CREATE UNIQUE INDEX IF NOT EXISTS "SignOffQuestion_tenantId_code_key"
  ON "SignOffQuestion"("tenantId", "code");

CREATE INDEX IF NOT EXISTS "SignOffQuestion_tenantId_idx"
  ON "SignOffQuestion"("tenantId");
