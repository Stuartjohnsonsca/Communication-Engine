-- Post-PRD hardening item 71 — push the FCG-window adherence signal
-- to FIRM_ADMINs when a tenant's 7d rate falls below threshold while
-- the volume floor is met. The daily cron audits the trip on the
-- affected tenant's own chain.
--
-- `IF NOT EXISTS` so a fresh deploy that already has this value from
-- the schema doesn't fail; an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FIRM_ADHERENCE_BELOW_THRESHOLD';
