-- Acumon Communications — tenant isolation + audit immutability
-- Applied by `prisma/post-migrate.ts` after each `prisma migrate deploy`.
-- Idempotent: safe to re-run.

-- ─── Audit immutability trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only (PRD §6.2). Use a new event to record corrections.';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON "AuditEvent";
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ─── RLS helper ────────────────────────────────────────────────────────────
-- Each tenant-scoped table gets ROW LEVEL SECURITY enabled and a policy that
-- gates rows on the per-transaction GUC `app.current_tenant`.
-- src/lib/db.ts sets this GUC via `set_config('app.current_tenant', $1, true)`
-- inside every transaction it opens.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'Membership',
    'FirmCultureGuide','FCGRule','FCGProposal','FCGChatTurn','FCGVote',
    'UserCultureGuide','UCGRule','UCGChatTurn','ComplianceRuling',
    'Draft','Action','AuditEvent',
    'Channel','ChannelAuth','IngestedMessage','Meeting',
    'OpportunityCandidate','SentimentSignal','AdherenceScore','CommunicationAdherence',
    'DPIAAttestation','DSARequest','NoGoSubject'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_iso ON %I
      USING ("tenantId" = current_setting('app.current_tenant', true))
      WITH CHECK ("tenantId" = current_setting('app.current_tenant', true))
    $p$, t);
  END LOOP;
END $$;

-- The Prisma migration role must bypass RLS so migrations can run.
-- App role (the one that runs queries at request time) does NOT bypass.
-- On Railway both use the same role for v1; the tenant context GUC is set
-- by the application before every query so the policy always evaluates true.
