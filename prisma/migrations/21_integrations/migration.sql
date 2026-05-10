-- PRD §10 Integrations — published catalogue of every integration target
-- Acumon offers (Tier 1 GA), commits to (Tier 2 within 6 months), positions
-- on the roadmap (Tier 3), or supports through the generic Integration SDK
-- (§10.4). Global table (no tenantId, NOT under RLS) so prospective and
-- current Clients see the same list. Same shape as Roadmap (§16), Risks
-- (§17) and Sub-Processors (§15.3): mutations gated by the page handler to
-- Acumon-tenant operators; audit events written against the operator's
-- tenant chain.
--
-- The migration seeds the v1 catalogue from PRD §10.1–10.4. Operators amend
-- delivery status (PLANNED → IN_DEVELOPMENT → AVAILABLE) and add new entries
-- through /integrations after deployment.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_TARGET_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_TARGET_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_TARGET_STATUS_CHANGED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntegrationTier') THEN
    CREATE TYPE "IntegrationTier" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3', 'SDK');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntegrationStatus') THEN
    CREATE TYPE "IntegrationStatus" AS ENUM ('PLANNED', 'IN_DEVELOPMENT', 'AVAILABLE', 'DEPRECATED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntegrationCategory') THEN
    CREATE TYPE "IntegrationCategory" AS ENUM (
      'EMAIL','CHAT','DOCUMENTS','CALENDAR','MEETINGS','E_SIGNATURE',
      'PRACTICE_MANAGEMENT','CRM','KNOWLEDGE_BASE','ACCOUNTING','TASK_MANAGEMENT','OTHER'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "IntegrationTarget" (
  "id"             TEXT PRIMARY KEY,
  "code"           TEXT NOT NULL,
  "ordinal"        INTEGER NOT NULL,
  "name"           TEXT NOT NULL,
  "vendor"         TEXT,
  "tier"           "IntegrationTier" NOT NULL,
  "category"       "IntegrationCategory" NOT NULL,
  "status"         "IntegrationStatus" NOT NULL DEFAULT 'PLANNED',
  "channelKind"    TEXT,
  "authMechanism"  TEXT NOT NULL DEFAULT 'oauth2',
  "requiredScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "capabilities"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "role"           TEXT,
  "notes"          TEXT,
  "targetGaAt"     TIMESTAMP(3),
  "availableSince" TIMESTAMP(3),
  "deprecatedAt"   TIMESTAMP(3),
  "export"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationTarget_code_key" ON "IntegrationTarget"("code");
CREATE INDEX IF NOT EXISTS "IntegrationTarget_tier_ordinal_idx"
  ON "IntegrationTarget"("tier", "ordinal");
CREATE INDEX IF NOT EXISTS "IntegrationTarget_category_status_idx"
  ON "IntegrationTarget"("category", "status");
CREATE INDEX IF NOT EXISTS "IntegrationTarget_status_idx" ON "IntegrationTarget"("status");

-- Seed Tier 1 (PRD §10.1) — required at GA. M365 + Google + Slack.
INSERT INTO "IntegrationTarget"
  ("id","code","ordinal","name","vendor","tier","category","status","channelKind","authMechanism","requiredScopes","capabilities","role","updatedAt")
VALUES
  ('itg-m365', 'm365', 0, 'Microsoft 365', 'Microsoft', 'TIER_1', 'EMAIL', 'AVAILABLE', 'M365', 'oauth2',
    ARRAY['Mail.Read','Mail.Send','Calendars.ReadWrite','Files.Read.All','Sites.Read.All','Tasks.ReadWrite','Chat.Read','offline_access'],
    ARRAY['drafts','calendar','meetings','documents','tasks','chat'],
    'Email + calendar + Teams chat + SharePoint/OneDrive documents + To-Do tasks', CURRENT_TIMESTAMP),
  ('itg-google', 'google-workspace', 1, 'Google Workspace', 'Google', 'TIER_1', 'EMAIL', 'AVAILABLE', 'GOOGLE', 'oauth2',
    ARRAY['gmail.readonly','gmail.send','calendar','drive.readonly','tasks','meetings.space.readonly'],
    ARRAY['drafts','calendar','meetings','documents','tasks'],
    'Gmail + Drive + Meet + Tasks + Calendar', CURRENT_TIMESTAMP),
  ('itg-slack', 'slack', 2, 'Slack', 'Salesforce', 'TIER_1', 'CHAT', 'AVAILABLE', 'SLACK', 'oauth2',
    ARRAY['channels:history','channels:read','chat:write','users:read','files:read'],
    ARRAY['drafts','chat'],
    'Firm-sanctioned workspaces only — never personal Slack', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Seed Tier 2 (PRD §10.2) — required within 6 months of GA.
INSERT INTO "IntegrationTarget"
  ("id","code","ordinal","name","vendor","tier","category","status","channelKind","authMechanism","requiredScopes","capabilities","role","notes","updatedAt")
VALUES
  ('itg-whatsapp-business', 'whatsapp-business', 10, 'WhatsApp Business', 'Meta', 'TIER_2', 'CHAT', 'PLANNED', 'WHATSAPP_BUSINESS', 'oauth2',
    ARRAY['whatsapp_business_messaging','business_management'],
    ARRAY['drafts','chat'],
    'Firm-sanctioned business deployments only',
    'Personal WhatsApp is excluded by policy and by integration design (PRD §17 risk + DPIA gating)', CURRENT_TIMESTAMP),
  ('itg-imanage', 'imanage', 11, 'iManage Work', 'iManage', 'TIER_2', 'DOCUMENTS', 'PLANNED', 'IMANAGE', 'oauth2',
    ARRAY['documents.read','documents.metadata'],
    ARRAY['documents'],
    'Legal document management',
    'Inherits iManage ACLs through to RAG retrieval per PRD §10.4', CURRENT_TIMESTAMP),
  ('itg-netdocs', 'netdocs', 12, 'NetDocuments', 'NetDocuments', 'TIER_2', 'DOCUMENTS', 'PLANNED', 'NETDOCUMENTS', 'oauth2',
    ARRAY['documents.read','workspaces.read'],
    ARRAY['documents'],
    'Legal document management',
    'Inherits NetDocs cabinet permissions per PRD §10.4', CURRENT_TIMESTAMP),
  ('itg-zoom', 'zoom', 13, 'Zoom', 'Zoom', 'TIER_2', 'MEETINGS', 'PLANNED', 'ZOOM', 'oauth2',
    ARRAY['meeting:read','recording:read','transcript:read'],
    ARRAY['meetings','minutes'],
    'Transcript ingestion with §7.5 consent flow',
    'Per-participant note-taking opt-out blocks transcript ingestion at meeting level', CURRENT_TIMESTAMP),
  ('itg-docusign', 'docusign', 14, 'DocuSign', 'DocuSign', 'TIER_2', 'E_SIGNATURE', 'PLANNED', NULL, 'webhook',
    ARRAY['envelope.events.read','envelope.status.read'],
    ARRAY['follow-ups','actions'],
    'Status events trigger follow-up Actions',
    'Webhook-driven; no inbound message channel', CURRENT_TIMESTAMP),
  ('itg-clio', 'clio', 15, 'Clio', 'Clio', 'TIER_2', 'PRACTICE_MANAGEMENT', 'PLANNED', NULL, 'oauth2',
    ARRAY['matters.read','contacts.read','tasks.readwrite'],
    ARRAY['actions','documents','tasks'],
    'Legal practice management', NULL, CURRENT_TIMESTAMP),
  ('itg-xero', 'xero', 16, 'Xero', 'Xero', 'TIER_2', 'ACCOUNTING', 'PLANNED', NULL, 'oauth2',
    ARRAY['accounting.contacts.read','accounting.transactions.read'],
    ARRAY['actions'],
    'Accounting / billing context for follow-ups', NULL, CURRENT_TIMESTAMP),
  ('itg-iris', 'iris', 17, 'IRIS', 'IRIS Software', 'TIER_2', 'PRACTICE_MANAGEMENT', 'PLANNED', NULL, 'api_key',
    ARRAY['matters.read','contacts.read'],
    ARRAY['actions','documents'],
    'Accountancy practice management', NULL, CURRENT_TIMESTAMP),
  ('itg-cch', 'cch', 18, 'CCH', 'Wolters Kluwer', 'TIER_2', 'PRACTICE_MANAGEMENT', 'PLANNED', NULL, 'api_key',
    ARRAY['matters.read','contacts.read'],
    ARRAY['actions','documents'],
    'Accountancy practice management', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Seed Tier 3 (PRD §10.3) — roadmap.
INSERT INTO "IntegrationTarget"
  ("id","code","ordinal","name","vendor","tier","category","status","channelKind","authMechanism","capabilities","role","updatedAt")
VALUES
  ('itg-hubspot', 'hubspot', 20, 'HubSpot', 'HubSpot', 'TIER_3', 'CRM', 'PLANNED', NULL, 'oauth2',
    ARRAY['actions','opportunities'], 'CRM where firms operate it', CURRENT_TIMESTAMP),
  ('itg-salesforce', 'salesforce', 21, 'Salesforce', 'Salesforce', 'TIER_3', 'CRM', 'PLANNED', NULL, 'oauth2',
    ARRAY['actions','opportunities'], 'CRM where firms operate it', CURRENT_TIMESTAMP),
  ('itg-confluence', 'confluence', 22, 'Confluence', 'Atlassian', 'TIER_3', 'KNOWLEDGE_BASE', 'PLANNED', NULL, 'oauth2',
    ARRAY['documents'], 'Internal knowledge base for grounding', CURRENT_TIMESTAMP),
  ('itg-notion', 'notion', 23, 'Notion', 'Notion Labs', 'TIER_3', 'KNOWLEDGE_BASE', 'PLANNED', NULL, 'oauth2',
    ARRAY['documents'], 'Internal knowledge base for grounding', CURRENT_TIMESTAMP),
  ('itg-calendly', 'calendly', 24, 'Calendly', 'Calendly', 'TIER_3', 'CALENDAR', 'PLANNED', NULL, 'oauth2',
    ARRAY['calendar','actions'], 'Scheduling automation', CURRENT_TIMESTAMP),
  ('itg-quickbooks', 'quickbooks', 25, 'QuickBooks Online', 'Intuit', 'TIER_3', 'ACCOUNTING', 'PLANNED', NULL, 'oauth2',
    ARRAY['actions'], 'Accounting / billing alternative', CURRENT_TIMESTAMP),
  ('itg-adobesign', 'adobesign', 26, 'Adobe Acrobat Sign', 'Adobe', 'TIER_3', 'E_SIGNATURE', 'PLANNED', NULL, 'webhook',
    ARRAY['follow-ups','actions'], 'E-signature alternative to DocuSign', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Seed §10.4 generic Integration SDK + MCP capability — surfaced in the
-- catalogue as a single row so prospective Clients understand the published
-- extensibility commitment without reading the schema.
INSERT INTO "IntegrationTarget"
  ("id","code","ordinal","name","tier","category","status","authMechanism","capabilities","role","notes","export","updatedAt")
VALUES
  ('itg-sdk', 'sdk', 30, 'Integration SDK + MCP adaptor', 'SDK', 'OTHER', 'IN_DEVELOPMENT', 'sdk',
    ARRAY['drafts','documents','actions','custom'],
    'Documented SDK + MCP-compatible adaptor layer for Client and partner extensions',
    'PRD §10.4 — auto-integration with arbitrary new software is a roadmap goal supported by the SDK and a managed-onboarding service, not a guaranteed v1 capability. Source-system permissions flow through to RAG retrieval.',
    'acumon.integration-sdk@1', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
