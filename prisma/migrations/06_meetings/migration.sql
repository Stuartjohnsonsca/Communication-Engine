-- Meeting paper drafting (PRD §7.4). Enriches the Meeting table with paper
-- lifecycle fields and adds MeetingParticipant. Also adds the new
-- MeetingPaperStatus enum and meeting-related audit event types.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'MeetingPaperStatus'
  ) THEN
    CREATE TYPE "MeetingPaperStatus" AS ENUM ('NONE', 'DRAFTED', 'EDITED', 'ISSUED');
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_PAPER_DRAFTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_PAPER_REGENERATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_PAPER_EDITED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_PAPER_ISSUED';

ALTER TABLE "Meeting"
  ADD COLUMN IF NOT EXISTS "description"            TEXT,
  ADD COLUMN IF NOT EXISTS "location"               TEXT,
  ADD COLUMN IF NOT EXISTS "durationMin"            INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "createdByMembershipId"  TEXT,
  ADD COLUMN IF NOT EXISTS "leadTimeWorkingDays"    INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "shortNotice"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "paperStatus"            "MeetingPaperStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "agenda"                 JSONB,
  ADD COLUMN IF NOT EXISTS "paperBody"              TEXT,
  ADD COLUMN IF NOT EXISTS "openQuestions"          JSONB,
  ADD COLUMN IF NOT EXISTS "paperGeneratedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paperIssuedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paperFcgVersionUsed"    INTEGER,
  ADD COLUMN IF NOT EXISTS "paperModelRunId"        TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "Meeting"
      ADD CONSTRAINT "Meeting_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Meeting_tenantId_paperStatus_idx"
  ON "Meeting"("tenantId", "paperStatus");

CREATE TABLE IF NOT EXISTS "MeetingParticipant" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "meetingId"        TEXT NOT NULL,
  "membershipId"     TEXT,
  "name"             TEXT NOT NULL,
  "email"            TEXT,
  "isExternal"       BOOLEAN NOT NULL DEFAULT false,
  "isMeetingCreator" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MeetingParticipant_meetingId_fkey'
  ) THEN
    ALTER TABLE "MeetingParticipant"
      ADD CONSTRAINT "MeetingParticipant_meetingId_fkey"
      FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "MeetingParticipant_tenantId_meetingId_idx"
  ON "MeetingParticipant"("tenantId", "meetingId");
