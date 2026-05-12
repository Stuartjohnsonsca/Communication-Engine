import type { DraftStatus } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 54 — stale-draft sweeper.
 *
 * The drafting agent populates `Draft.fcgWindowDeadline` from the
 * tenant's FCG cadence rule ("respond within N hours / acknowledge
 * within M minutes"). That field is the engine's commitment back to
 * the FCG: "if you don't see this draft sent by then, the firm has
 * silently broken its own response-time promise." But until now
 * nothing surfaced when that deadline passed — the draft just sat in
 * /drafts and the User got to it when they got to it.
 *
 * This sweep, run daily, scans Drafts whose `fcgWindowDeadline` has
 * passed and which are still in a non-terminal state (PROPOSED,
 * EDITED, ACCEPTED — i.e. not SENT, not DISCARDED), and fires one
 * `draft_stale` notification to the owning Membership. Idempotent via
 * the dispatch table; once warned, never re-warned for the same
 * draft. (If a User regenerates a stale draft, the new draft is a
 * separate row with its own deadline and warning slot — same
 * pattern as `parentId` lineage already enforces for citations
 * + actions.)
 *
 * Skip conditions:
 *   - `fcgWindowDeadline` is null — many drafts have no deadline
 *     (substantive responses where the FCG sets no window; technical
 *     drafts; ACTION_ONLY drafts). These can never be "stale" against
 *     a promise that wasn't made.
 *   - `fcgWindowDeadline` is in the future — not yet due.
 *   - `status` is SENT, DISCARDED, or any non-listed value — the
 *     draft has reached a terminal state.
 *   - Owning Membership is not ACTIVE — same lifecycle gate as the
 *     channel-auth expiry path. Pinging a leaver about an overdue
 *     draft is useless; the FCT escalation path is a future item.
 *   - The User's email is missing — defence in depth; should not
 *     happen for ACTIVE memberships.
 *
 * Notification kind `draft_stale` is mandatory (not opt-outable). The
 * FCG promise is the engine's central value prop; if a User can mute
 * the breach warning, the engine silently fails the firm's commitment
 * to its clients.
 *
 * Audit event `DRAFT_STALE_WARNED` lands on the tenant chain. The
 * dispatch row's payload mirrors the audit payload so a reviewer can
 * answer "what was overdue when we warned, and by how long?"
 */

const ACTIVE_DRAFT_STATUSES: DraftStatus[] = ["PROPOSED", "EDITED", "ACCEPTED"];

export type DraftStaleSweepResult = {
  /// Drafts inspected this pass (past deadline, non-terminal, across
  /// the requested scope).
  scanned: number;
  /// First-time warnings dispatched this pass.
  warned: number;
  /// Dispatch row already existed for this draft — counted but not
  /// re-actioned. Cron is daily, so this is the steady-state line.
  alreadyWarned: number;
  /// Skipped for any of the documented reasons above.
  skipped: number;
  /// Persist / dispatch threw. Logged via `reportError`; cron does not
  /// abort on a single failure.
  errored: number;
};

export async function runDraftStaleSweep(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<DraftStaleSweepResult> {
  const now = opts?.now ?? new Date();

  const drafts = await superDb.draft.findMany({
    where: {
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      status: { in: ACTIVE_DRAFT_STATUSES },
      fcgWindowDeadline: { lt: now },
    },
    include: {
      membership: {
        select: {
          id: true,
          status: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  const result: DraftStaleSweepResult = {
    scanned: drafts.length,
    warned: 0,
    alreadyWarned: 0,
    skipped: 0,
    errored: 0,
  };

  for (const draft of drafts) {
    try {
      if (!draft.fcgWindowDeadline) {
        // The `fcgWindowDeadline: { lt: now }` clause filtered nulls,
        // but TypeScript can't see that.
        result.skipped += 1;
        continue;
      }
      if (!draft.membership || draft.membership.status !== "ACTIVE") {
        result.skipped += 1;
        continue;
      }
      if (!draft.membership.user.email) {
        result.skipped += 1;
        continue;
      }

      const minutesOverdue = Math.max(
        0,
        Math.floor((now.getTime() - draft.fcgWindowDeadline.getTime()) / 60000),
      );
      const overdueLabel = formatOverdue(minutesOverdue);
      const subjectLabel = draft.subject?.trim() || "(no subject)";
      const subject = `Overdue draft (${overdueLabel}): ${subjectLabel}`;
      const text =
        `A draft you own has passed its FCG response window.\n\n` +
        `Subject: ${subjectLabel}\n` +
        `Status: ${draft.status}\n` +
        `Kind: ${draft.kind}${draft.holdingRequired ? " (holding)" : ""}\n` +
        `FCG deadline: ${draft.fcgWindowDeadline.toISOString()}\n` +
        `Overdue by: ${overdueLabel}\n\n` +
        `Open the draft to review, edit, or mark sent — the firm's FCG ` +
        `committed to a response window for this thread and the engine is ` +
        `surfacing the lapse so you can act before the client notices.`;

      const dispatch = await dispatchNotification({
        tenantId: draft.tenantId,
        membershipId: draft.membership.id,
        toEmail: draft.membership.user.email,
        kind: "draft_stale",
        dedupeKey: draft.id,
        subject,
        text,
        summary: subject,
        href: `/drafts/${draft.id}`,
        payload: {
          draftId: draft.id,
          status: draft.status,
          kind: draft.kind,
          fcgWindowDeadline: draft.fcgWindowDeadline.toISOString(),
          minutesOverdue,
          holdingRequired: draft.holdingRequired,
        },
      });

      if (dispatch.alreadySent) {
        result.alreadyWarned += 1;
        continue;
      }

      result.warned += 1;

      await writeAuditEvent({
        tenantId: draft.tenantId,
        eventType: "DRAFT_STALE_WARNED",
        actorMembershipId: null,
        subjectType: "Draft",
        subjectId: draft.id,
        payload: {
          draftId: draft.id,
          membershipId: draft.membership.id,
          status: draft.status,
          kind: draft.kind,
          fcgWindowDeadline: draft.fcgWindowDeadline.toISOString(),
          minutesOverdue,
          dispatchId: dispatch.dispatchId ?? null,
        },
      });
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/drafts/stale-sweep",
          tenantId: draft.tenantId,
          extra: { draftId: draft.id },
        },
        "draft-stale sweep dispatch failed",
      );
      result.errored += 1;
    }
  }

  return result;
}

function formatOverdue(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
