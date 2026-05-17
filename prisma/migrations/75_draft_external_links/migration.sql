-- Backlog item 113 — drafts in the User's actual mailbox.
--
-- Three nullable columns on `Draft` capturing the cross-system link to
-- the provider-side draft (Outlook Message via Graph, Gmail Draft via
-- the Gmail API). When the push helper succeeds it fills all three;
-- on failure or when no draftable channel is connected they remain
-- NULL and the Draft is in-app only. No index — these are written once
-- per draft and read only via the same row when the /drafts list
-- renders the "Open in Outlook / Gmail" deep-link.

ALTER TABLE "Draft"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalDraftId"  TEXT,
  ADD COLUMN "externalDraftUrl" TEXT;

-- The push helper writes one audit event per successful push so the
-- chain records every cross-system materialisation. Idempotent ADD
-- so re-running the migration doesn't error.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFT_PUSHED_TO_MAILBOX';
