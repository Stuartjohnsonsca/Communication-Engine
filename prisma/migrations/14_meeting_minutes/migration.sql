-- PRD §7.5 Meeting Notes and Minutes. Adds:
--   * Pre-meeting note-taking disclosure + per-participant opt-out, with a
--     meeting-level `noteTakingBlocked` gate set true if any participant
--     opts out (per PRD: any opt-out disables transcript ingestion).
--   * Transcript persistence on the Meeting row (one canonical transcript
--     per meeting; re-uploading replaces).
--   * `chairMembershipId` defaulting to paper-author at creation; the
--     Chair approves Minutes before circulation.
--   * `MeetingRecord` table holding Summary and Formal Minutes (one row per
--     (meeting, kind)). Body is markdown; lifecycle is
--     DRAFTED → EDITED → APPROVED → CIRCULATED.
--   * New audit event types for the §7.5 lifecycle.
--
-- The new MeetingRecord table is added to the RLS policy via prisma/rls.sql
-- (sibling change in this commit).

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MeetingRecordKind') THEN
    CREATE TYPE "MeetingRecordKind" AS ENUM ('SUMMARY', 'MINUTES');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MeetingRecordStatus') THEN
    CREATE TYPE "MeetingRecordStatus" AS ENUM ('DRAFTED', 'EDITED', 'APPROVED', 'CIRCULATED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TranscriptSource') THEN
    CREATE TYPE "TranscriptSource" AS ENUM ('TEAMS', 'ZOOM', 'MEET', 'MANUAL');
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_NOTE_TAKING_DISCLOSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_NOTE_TAKING_OPTED_OUT';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_NOTE_TAKING_BLOCKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_TRANSCRIPT_INGESTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_SUMMARY_DRAFTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_SUMMARY_APPROVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_MINUTES_DRAFTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_MINUTES_APPROVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEETING_MINUTES_CIRCULATED';

-- ─── Meeting columns ───────────────────────────────────────────────────────

ALTER TABLE "Meeting"
  ADD COLUMN IF NOT EXISTS "chairMembershipId"     TEXT,
  ADD COLUMN IF NOT EXISTS "noteTakingDisclosedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "noteTakingBlocked"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "noteTakingBlockReason" TEXT,
  ADD COLUMN IF NOT EXISTS "transcriptBody"        TEXT,
  ADD COLUMN IF NOT EXISTS "transcriptSource"      "TranscriptSource",
  ADD COLUMN IF NOT EXISTS "transcriptIngestedAt"  TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Meeting_chairMembershipId_fkey'
  ) THEN
    ALTER TABLE "Meeting"
      ADD CONSTRAINT "Meeting_chairMembershipId_fkey"
      FOREIGN KEY ("chairMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: for existing meetings the chair is the paper-author (default per
-- PRD §7.5). Any meeting where this is wrong can be reassigned in the UI.
UPDATE "Meeting"
   SET "chairMembershipId" = "paperAuthorMembershipId"
 WHERE "chairMembershipId" IS NULL
   AND "paperAuthorMembershipId" IS NOT NULL;

-- ─── MeetingParticipant columns ────────────────────────────────────────────

ALTER TABLE "MeetingParticipant"
  ADD COLUMN IF NOT EXISTS "noteTakingOptedOut"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "noteTakingOptedOutAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "noteTakingOptOutReason" TEXT;

-- ─── MeetingRecord ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "MeetingRecord" (
  "id"                       TEXT PRIMARY KEY,
  "tenantId"                 TEXT NOT NULL,
  "meetingId"                TEXT NOT NULL,
  "kind"                     "MeetingRecordKind"   NOT NULL,
  "status"                   "MeetingRecordStatus" NOT NULL DEFAULT 'DRAFTED',
  "body"                     TEXT NOT NULL,
  "generatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt"               TIMESTAMP(3),
  "approvedByMembershipId"   TEXT,
  "circulatedAt"             TIMESTAMP(3),
  "circulatedByMembershipId" TEXT,
  "fcgVersionUsed"           INTEGER,
  "modelRunId"               TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MeetingRecord_meetingId_fkey'
  ) THEN
    ALTER TABLE "MeetingRecord"
      ADD CONSTRAINT "MeetingRecord_meetingId_fkey"
      FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "MeetingRecord_meetingId_kind_key"
  ON "MeetingRecord"("meetingId", "kind");

CREATE INDEX IF NOT EXISTS "MeetingRecord_tenantId_meetingId_idx"
  ON "MeetingRecord"("tenantId", "meetingId");

CREATE INDEX IF NOT EXISTS "MeetingRecord_tenantId_status_idx"
  ON "MeetingRecord"("tenantId", "status");
