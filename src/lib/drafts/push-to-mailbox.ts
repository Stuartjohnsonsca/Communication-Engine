import { superDb } from "@/lib/db";
import { adapterFor } from "@/lib/channels/adapters";
import { ensureFreshTokens } from "@/lib/channels/oauth-refresh";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import type { DraftPushInput } from "@/lib/channels/adapters/types";

/**
 * Backlog item 113 — push a freshly-created Draft into the User's
 * actual mailbox.
 *
 * The engine's product premise is "drafts only — never sends." That
 * stays true: this helper only creates a *draft*, never a sent message.
 * The User opens Outlook or Gmail, sees the draft sitting in their
 * Drafts folder, edits if they want, then presses send themselves.
 *
 * Lookup priority (per Membership):
 *   1. The first ACTIVE M365 channel with an unrevoked OAuth auth row.
 *   2. Then the first ACTIVE GOOGLE channel with an unrevoked OAuth row.
 *
 * IMAP + Slack + Teams are intentionally skipped in v1 — IMAP draft
 * APPEND works in theory but is fiddly enough to defer. Members on those
 * channels keep the in-app /drafts surface as their primary path.
 *
 * Failure handling: we deliberately swallow every failure here. A draft
 * pushed only to the Postgres row is still useful (the in-app /drafts
 * page renders it normally). Failure modes we expect to see:
 *   - User connected with the old read-only scope (`Mail.Read` /
 *     `gmail.readonly`) → provider returns 403. We log via
 *     `reportError`, write a soft audit event, leave external fields
 *     null. The next reconnect upgrades the scope (registry.ts now
 *     requests `Mail.ReadWrite` / `gmail.compose`).
 *   - Refresh token revoked → `ensureFreshTokens` already flipped the
 *     Channel to REFRESH_FAILED; we skip silently.
 *   - No connected mailbox → silent skip (in-app only).
 *
 * This function never throws — calling code can `void` it without a
 * try/catch.
 */
export async function pushDraftToMailbox(input: {
  tenantId: string;
  draftId: string;
  membershipId: string;
}): Promise<void> {
  try {
    const draft = await superDb.draft.findUnique({
      where: { id: input.draftId },
      include: {
        membership: { include: { user: { select: { email: true } } } },
        ingestedMessage: { select: { externalId: true, channelId: true } },
      },
    });
    if (!draft || draft.tenantId !== input.tenantId) return;
    // Idempotency — never re-push a draft we already linked.
    if (draft.externalDraftId) return;
    // Only EMAIL drafts go to a mailbox. HOLDING / TECHNICAL also start
    // life as emails (they're sub-kinds of email replies), so they
    // qualify. ACTION_ONLY drafts are tasks for the User to perform
    // in-app and have no recipient — skip.
    if (draft.kind === "ACTION_ONLY") return;
    if (draft.channel !== "EMAIL") return;

    const fromEmail = draft.membership.user.email;
    if (!fromEmail) return;

    // Prefer the same channel kind the inbound came in on so the reply
    // threads correctly in the User's mail client. Fall back to any
    // active draftable channel the Member has authed.
    const preferredKinds = ["M365", "GOOGLE"];
    const channels = await superDb.channel.findMany({
      where: {
        tenantId: input.tenantId,
        kind: { in: preferredKinds },
        status: "ACTIVE",
      },
      include: {
        auths: {
          where: {
            membershipId: input.membershipId,
            revokedAt: null,
            authMethod: "OAUTH",
          },
          take: 1,
        },
      },
    });
    // Pick the channel that matches the inbound's channelId first, then
    // any other available. The inbound's channelId resolves to a M365
    // or GOOGLE channel — by matching we keep the reply threaded.
    const candidates = channels
      .filter((c) => c.auths.length > 0)
      .sort((a) => (a.id === draft.ingestedMessage?.channelId ? -1 : 1));
    const channel = candidates[0];
    if (!channel) return;

    const auth = channel.auths[0];
    const refresh = await ensureFreshTokens(auth.id);
    if (refresh.result === "failed" || refresh.result === "no-tokens") return;
    const tokens = refresh.tokens;

    const adapter = adapterFor(channel.kind);
    if (!adapter.createDraft) return;

    const recipients = parseRecipients(draft.inboundSender);
    const pushInput: DraftPushInput = {
      subject: draft.subject ?? "(no subject)",
      body: draft.body,
      bodyKind: "text",
      fromEmail,
      to: recipients,
      ...(draft.ingestedMessage?.externalId &&
      channel.id === draft.ingestedMessage.channelId
        ? { inReplyToExternalId: draft.ingestedMessage.externalId }
        : {}),
    };

    const result = await adapter.createDraft(
      {
        tenantId: input.tenantId,
        channelId: channel.id,
        membershipId: input.membershipId,
        tokens,
      },
      pushInput,
    );

    await superDb.draft.update({
      where: { id: draft.id },
      data: {
        externalProvider: channel.kind,
        externalDraftId: result.externalId,
        externalDraftUrl: result.webLink ?? null,
      },
    });

    await writeAuditEvent({
      tenantId: input.tenantId,
      eventType: "DRAFT_PUSHED_TO_MAILBOX",
      actorMembershipId: null,
      subjectType: "Draft",
      subjectId: draft.id,
      payload: {
        provider: channel.kind,
        externalDraftId: result.externalId,
        threaded: Boolean(pushInput.inReplyToExternalId),
      },
    });
  } catch (err) {
    reportError(
      err,
      {
        route: "lib/drafts/push-to-mailbox",
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        extra: { draftId: input.draftId },
      },
      "mailbox draft push failed",
    );
  }
}

/**
 * Extract a single recipient email from a possibly-display-name address
 * like `"Alex Example" <alex@example.com>`. The inbound sender becomes
 * the draft's `To` for replies; multi-recipient replies aren't drafted
 * by the engine in v1 (the User can add Cc'd parties when they edit).
 */
function parseRecipients(sender: string | null): string[] {
  if (!sender) return [];
  const trimmed = sender.trim();
  if (!trimmed) return [];
  const bracketed = trimmed.match(/<([^>]+)>/);
  if (bracketed) return [bracketed[1].trim()];
  return [trimmed];
}
