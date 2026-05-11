-- Post-PRD hardening item 24: sub-processor change notification with prior
-- notice window.
--
-- DPA art. 28(2)(a) obligates Acumon, as processor, to give every Client
-- (controller) advance notice of additions or replacements of
-- sub-processors so the Client can object before the change takes effect.
-- Section §15.3 of the PRD shipped the SubProcessor catalogue but the
-- existing isActive toggle flipped silently and instantly — this migration
-- adds the announcement + notice-window layer.
--
--   SubProcessorChange     — global, lifecycle ANNOUNCED → EFFECTIVE | CANCELLED
--   SubProcessorObjection  — per-tenant, RLS-protected; the Client's
--                            recorded objection during the notice window
--
-- New audit events:
--   SUBPROCESSOR_CHANGE_ANNOUNCED   (operator chain — on announce)
--   SUBPROCESSOR_CHANGE_CANCELLED   (operator chain — on operator-side abort)
--   SUBPROCESSOR_CHANGE_EFFECTIVE   (operator chain — on lifecycle promotion)
--   SUBPROCESSOR_OBJECTION_RAISED   (Client chain — on objection lodged)
--   SUBPROCESSOR_OBJECTION_WITHDRAWN (Client chain — on withdrawal)

CREATE TYPE "SubProcessorChangeKind" AS ENUM (
  'ADDED',
  'REMOVED',
  'MATERIAL_UPDATE'
);

CREATE TYPE "SubProcessorChangeStatus" AS ENUM (
  'ANNOUNCED',
  'EFFECTIVE',
  'CANCELLED'
);

CREATE TABLE "SubProcessorChange" (
  "id"              TEXT PRIMARY KEY,
  "subProcessorId"  TEXT NOT NULL REFERENCES "SubProcessor"("id") ON DELETE CASCADE,
  "description"     TEXT NOT NULL,
  "kind"            "SubProcessorChangeKind" NOT NULL,
  "status"          "SubProcessorChangeStatus" NOT NULL DEFAULT 'ANNOUNCED',
  "announcedAt"     TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "effectiveAt"     TIMESTAMP(3) NOT NULL,
  "confirmedAt"     TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelledReason" TEXT,
  "announcedById"   TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX "SubProcessorChange_status_effectiveAt_idx"
  ON "SubProcessorChange"("status", "effectiveAt");
CREATE INDEX "SubProcessorChange_subProcessorId_announcedAt_idx"
  ON "SubProcessorChange"("subProcessorId", "announcedAt" DESC);

CREATE TABLE "SubProcessorObjection" (
  "id"                   TEXT PRIMARY KEY,
  "tenantId"             TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "subProcessorChangeId" TEXT NOT NULL REFERENCES "SubProcessorChange"("id") ON DELETE CASCADE,
  "raisedById"           TEXT NOT NULL,
  "reason"               TEXT NOT NULL,
  "raisedAt"             TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "withdrawnAt"          TIMESTAMP(3),
  "withdrawnReason"      TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "SubProcessorObjection_tenantId_subProcessorChangeId_key"
  ON "SubProcessorObjection"("tenantId", "subProcessorChangeId");
CREATE INDEX "SubProcessorObjection_subProcessorChangeId_idx"
  ON "SubProcessorObjection"("subProcessorChangeId");

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_CHANGE_ANNOUNCED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_CHANGE_CANCELLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_CHANGE_EFFECTIVE';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_OBJECTION_RAISED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_OBJECTION_WITHDRAWN';
