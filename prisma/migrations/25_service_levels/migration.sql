-- PRD §13 Non-Functional Requirements — SLA targets, supported languages
-- and the accessibility statement. Three new tables, all global except
-- SlaMeasurement which is tenant-scoped + RLS-protected so each Client
-- only sees their own performance numbers.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SLA_TARGET_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SLA_MEASUREMENT_RECORDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'LANGUAGE_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'LANGUAGE_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ACCESSIBILITY_STATEMENT_PUBLISHED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SlaKind') THEN
    CREATE TYPE "SlaKind" AS ENUM ('AVAILABILITY','LATENCY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SlaOutcome') THEN
    CREATE TYPE "SlaOutcome" AS ENUM ('MET','MISSED','INSUFFICIENT_DATA');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "SlaTarget" (
  "id"          TEXT PRIMARY KEY,
  "code"        TEXT NOT NULL,
  "ordinal"     INTEGER NOT NULL,
  "name"        TEXT NOT NULL,
  "kind"        "SlaKind" NOT NULL,
  "threshold"   DOUBLE PRECISION NOT NULL,
  "unit"        TEXT NOT NULL,
  "aggregation" TEXT NOT NULL,
  "scope"       TEXT NOT NULL,
  "notes"       TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SlaTarget_code_key" ON "SlaTarget"("code");
CREATE INDEX IF NOT EXISTS "SlaTarget_ordinal_idx" ON "SlaTarget"("ordinal");
CREATE INDEX IF NOT EXISTS "SlaTarget_kind_active_idx" ON "SlaTarget"("kind","isActive");

CREATE TABLE IF NOT EXISTS "SlaMeasurement" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "targetId"       TEXT NOT NULL,
  "period"         TEXT NOT NULL,
  "observed"       DOUBLE PRECISION,
  "outcome"        "SlaOutcome" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  "sampleN"        INTEGER NOT NULL DEFAULT 0,
  "payload"        JSONB,
  "note"           TEXT,
  "recordedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByName" TEXT,
  CONSTRAINT "SlaMeasurement_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "SlaMeasurement_target_fk"
    FOREIGN KEY ("targetId") REFERENCES "SlaTarget"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SlaMeasurement_tenant_target_period_key"
  ON "SlaMeasurement"("tenantId","targetId","period");
CREATE INDEX IF NOT EXISTS "SlaMeasurement_tenant_period_idx"
  ON "SlaMeasurement"("tenantId","period");
CREATE INDEX IF NOT EXISTS "SlaMeasurement_target_period_idx"
  ON "SlaMeasurement"("targetId","period");
CREATE INDEX IF NOT EXISTS "SlaMeasurement_outcome_idx"
  ON "SlaMeasurement"("outcome");

CREATE TABLE IF NOT EXISTS "SupportedLanguage" (
  "id"          TEXT PRIMARY KEY,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "nativeName"  TEXT NOT NULL,
  "ordinal"     INTEGER NOT NULL,
  "isInterface" BOOLEAN NOT NULL DEFAULT true,
  "isDrafting"  BOOLEAN NOT NULL DEFAULT true,
  "rtl"         BOOLEAN NOT NULL DEFAULT false,
  "notes"       TEXT,
  "addedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportedLanguage_code_key" ON "SupportedLanguage"("code");
CREATE INDEX IF NOT EXISTS "SupportedLanguage_ordinal_idx" ON "SupportedLanguage"("ordinal");
CREATE INDEX IF NOT EXISTS "SupportedLanguage_interface_drafting_idx"
  ON "SupportedLanguage"("isInterface","isDrafting");

CREATE TABLE IF NOT EXISTS "AccessibilityStatement" (
  "id"              TEXT PRIMARY KEY,
  "version"         INTEGER NOT NULL,
  "conformanceTo"   TEXT NOT NULL,
  "claim"           TEXT NOT NULL,
  "body"            TEXT NOT NULL,
  "auditedAt"       TIMESTAMP(3),
  "auditedByName"   TEXT,
  "knownIssues"     JSONB NOT NULL DEFAULT '[]',
  "isActive"        BOOLEAN NOT NULL DEFAULT false,
  "publishedAt"     TIMESTAMP(3),
  "publishedByName" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AccessibilityStatement_version_key"
  ON "AccessibilityStatement"("version");
CREATE INDEX IF NOT EXISTS "AccessibilityStatement_isActive_idx"
  ON "AccessibilityStatement"("isActive");

-- Seed PRD §13.1 SLA targets verbatim.
INSERT INTO "SlaTarget"
  ("id","code","ordinal","name","kind","threshold","unit","aggregation","scope","notes","updatedAt")
VALUES
  ('sla-availability-business', 'availability-business', 0, 'Availability — business hours', 'AVAILABILITY',
    99.9, '%', 'monthly_pct', '07:00–19:00 local',
    'PRD §13.1 — primary commitment during business hours.', CURRENT_TIMESTAMP),
  ('sla-availability-overall', 'availability-overall', 1, 'Availability — overall', 'AVAILABILITY',
    99.5, '%', 'monthly_pct', 'Calendar month, all hours',
    'PRD §13.1 — overall floor.', CURRENT_TIMESTAMP),
  ('sla-drafting-short', 'drafting-latency-short', 2, 'Drafting latency — short drafts (median)', 'LATENCY',
    5, 's', 'median', 'EMAIL + ACTION_ONLY drafts',
    'PRD §13.1 — median ≤ 5s for short drafts.', CURRENT_TIMESTAMP),
  ('sla-drafting-technical', 'drafting-latency-technical', 3, 'Drafting latency — technical drafts (median)', 'LATENCY',
    30, 's', 'median', 'TECHNICAL drafts requiring retrieval',
    'PRD §13.1 — median ≤ 30s for retrieval-grounded technical drafts.', CURRENT_TIMESTAMP),
  ('sla-judge', 'compliance-judge-latency', 4, 'Compliance evaluation latency at UCG commit', 'LATENCY',
    10, 's', 'median', 'UCG commit-time judge runs',
    'PRD §13.1 — ≤ 10s at UCG commit time.', CURRENT_TIMESTAMP),
  ('sla-voice', 'voice-transcription-latency', 5, 'Voice transcription latency', 'LATENCY',
    2, '× audio duration', 'median', 'Voice channel transcript runs',
    'PRD §13.1 — ≤ 2× audio duration. Engaged only when a voice channel is active.', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Seed PRD §13.5 GA languages.
INSERT INTO "SupportedLanguage"
  ("id","code","name","nativeName","ordinal","isInterface","isDrafting","updatedAt")
VALUES
  ('lang-en-gb', 'en-GB', 'English (UK)', 'English',     0, true, true, CURRENT_TIMESTAMP),
  ('lang-fr',    'fr',    'French',       'Français',    1, true, true, CURRENT_TIMESTAMP),
  ('lang-de',    'de',    'German',       'Deutsch',     2, true, true, CURRENT_TIMESTAMP),
  ('lang-es',    'es',    'Spanish',      'Español',     3, true, true, CURRENT_TIMESTAMP),
  ('lang-it',    'it',    'Italian',      'Italiano',    4, true, true, CURRENT_TIMESTAMP),
  ('lang-nl',    'nl',    'Dutch',        'Nederlands',  5, true, true, CURRENT_TIMESTAMP),
  ('lang-pt',    'pt',    'Portuguese',   'Português',   6, true, true, CURRENT_TIMESTAMP),
  ('lang-pl',    'pl',    'Polish',       'Polski',      7, true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Seed initial Accessibility Statement (WCAG 2.2 AA target).
INSERT INTO "AccessibilityStatement"
  ("id","version","conformanceTo","claim","body","isActive","publishedAt","publishedByName","updatedAt")
VALUES
  ('access-v1', 1, 'WCAG 2.2 AA', 'Partially conformant',
    E'Acumon Communications targets WCAG 2.2 AA conformance for all user-facing surfaces.\n\nKey commitments\n  - Keyboard-only operation for every chat and dashboard flow.\n  - Screen-reader-friendly draft display, including citation references.\n  - Respect for prefers-reduced-motion and prefers-color-scheme.\n  - Visible focus on every interactive element.\n\nInitial assessment\n  - Self-assessment performed during build. Independent audit scheduled before GA per PRD §16 phase P1.\n  - Known issues are tracked in this statement and remediated against the next release window.\n\nFeedback\n  - accessibility@acumon.example reaches the Acumon product team. Reasonable adjustments are offered to reach parity for any user that reports a barrier.',
    true, CURRENT_TIMESTAMP, 'Acumon Intelligence', CURRENT_TIMESTAMP)
ON CONFLICT ("version") DO NOTHING;
