-- PRD §12.9 Breach Notification. Acumon (as processor) notifies affected
-- Clients without undue delay and within 24 hours of becoming aware of a
-- personal-data breach. Notifications include all information required to
-- enable each Client to meet its 72-hour ICO/EDPB obligation.
--
-- BreachIncident is global (Acumon-side); BreachClientNotification is
-- tenant-scoped + RLS-protected so each Client only sees notifications
-- addressed to them.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_DETECTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_TRIAGED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_CONTAINED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_RESOLVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_CLIENT_NOTIFIED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BREACH_UPDATE_PUBLISHED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BreachStatus') THEN
    CREATE TYPE "BreachStatus" AS ENUM ('TRIAGE','INVESTIGATING','CONTAINED','RESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BreachSeverity') THEN
    CREATE TYPE "BreachSeverity" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BreachNotificationStatus') THEN
    CREATE TYPE "BreachNotificationStatus" AS ENUM ('PENDING','NOTIFIED','ACKNOWLEDGED','SUPERSEDED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BreachIncident" (
  "id"                  TEXT PRIMARY KEY,
  "code"                TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "detectedAt"          TIMESTAMP(3),
  "awareAt"             TIMESTAMP(3) NOT NULL,
  "severity"            "BreachSeverity" NOT NULL,
  "status"              "BreachStatus" NOT NULL DEFAULT 'TRIAGE',
  "isPersonalData"      BOOLEAN NOT NULL DEFAULT true,
  "affectedCategories"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rootCause"           TEXT,
  "mitigations"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "affectedClientCount" INTEGER NOT NULL DEFAULT 0,
  "containedAt"         TIMESTAMP(3),
  "resolvedAt"          TIMESTAMP(3),
  "recordedByName"      TEXT NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "BreachIncident_code_key" ON "BreachIncident"("code");
CREATE INDEX IF NOT EXISTS "BreachIncident_status_idx" ON "BreachIncident"("status");
CREATE INDEX IF NOT EXISTS "BreachIncident_awareAt_idx" ON "BreachIncident"("awareAt");
CREATE INDEX IF NOT EXISTS "BreachIncident_severity_status_idx"
  ON "BreachIncident"("severity","status");

CREATE TABLE IF NOT EXISTS "BreachClientNotification" (
  "id"                  TEXT PRIMARY KEY,
  "tenantId"            TEXT NOT NULL,
  "breachIncidentId"    TEXT NOT NULL,
  "status"              "BreachNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "dueAt"               TIMESTAMP(3) NOT NULL,
  "notifiedAt"          TIMESTAMP(3),
  "notifiedByName"      TEXT,
  "notifiedToName"      TEXT,
  "notifiedToRole"      TEXT,
  "acknowledgedAt"      TIMESTAMP(3),
  "acknowledgedByName"  TEXT,
  "payload"             TEXT,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BreachClientNotification_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "BreachClientNotification_incident_fk"
    FOREIGN KEY ("breachIncidentId") REFERENCES "BreachIncident"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BreachClientNotification_tenant_incident_key"
  ON "BreachClientNotification"("tenantId","breachIncidentId");
CREATE INDEX IF NOT EXISTS "BreachClientNotification_tenant_status_idx"
  ON "BreachClientNotification"("tenantId","status");
CREATE INDEX IF NOT EXISTS "BreachClientNotification_incident_idx"
  ON "BreachClientNotification"("breachIncidentId");
CREATE INDEX IF NOT EXISTS "BreachClientNotification_dueAt_idx"
  ON "BreachClientNotification"("dueAt");
