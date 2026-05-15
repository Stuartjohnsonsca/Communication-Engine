import { superDb } from "@/lib/db";
import { encryptJson, decryptJson } from "@/lib/channels/crypto";
import { writeAuditEvent } from "@/lib/audit";
import { resolveCronThresholds } from "@/lib/cron-thresholds/resolve";
import { revokePriorAuthsForMembership } from "@/lib/channels/auths";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";
import { ValidationError, NotFoundError, ForbiddenError } from "@/lib/api-errors";

/**
 * Item 110 — per-staff password-credential lifecycle for IMAP-style
 * channels. Sibling to `auths.ts` (which handles OAuth-shaped
 * credentials) on the same `ChannelAuth` table; the discriminator
 * `authMethod = "PASSWORD"` differentiates rows.
 *
 * What this module does:
 *   - `setPasswordCreds`: insert (or replace) a per-Member IMAP
 *     credential row. Called by `/api/channels/[id]/connect-imap`.
 *     Soft-revokes any prior ACTIVE auth for the same (channel,
 *     membership) pair via the existing item-104 helper, then
 *     creates a fresh row with `authMethod: "PASSWORD"`,
 *     encryptedTokens = `{kind: "password", username, password}`,
 *     `nextReauthAt = now + tenantReauthDays`. Writes
 *     `CHANNEL_PASSWORD_AUTH_REENTERED` audit (with
 *     `isFreshConnect` discriminating first-time vs re-entry).
 *   - `getPasswordCreds`: decrypt and return the stored
 *     username/password. Called by the IMAP adapter at ingest
 *     time. Plaintext should NEVER be cached, logged, or
 *     returned over an API.
 *   - `extendReauthDeadline`: per-User extension. Validates the
 *     new deadline is LATER than the current one (cannot reduce)
 *     AND >= `now + tenantReauthDays` (cannot dip below the
 *     tenant floor). Writes `CHANNEL_PASSWORD_REAUTH_EXTENDED`
 *     audit so chain readers can spot a User who keeps extending.
 *   - `markPasswordAuthFailed`: called by `runIngest`'s per-Member
 *     catch when the IMAP adapter throws `ImapAuthError`. Stamps
 *     `lastFailureAt`, fires mandatory `channel_auth_failed`
 *     notification (deduped per-day so a chronic failure loop
 *     doesn't flood the inbox), writes
 *     `CHANNEL_PASSWORD_AUTH_FAILED` audit.
 *   - `clearPasswordAuthFailure`: called by `setPasswordCreds`
 *     when a successful re-entry happens — wipes
 *     `lastFailureAt`/`lastFailureReason` so the /account inline
 *     prompt clears.
 */

export type PasswordCredsBlob = {
  kind: "password";
  username: string;
  password: string;
};

export async function getPasswordCreds(
  authId: string,
): Promise<PasswordCredsBlob | null> {
  const row = await superDb.channelAuth.findUnique({
    where: { id: authId },
    select: { encryptedTokens: true, authMethod: true, revokedAt: true },
  });
  if (!row || row.revokedAt !== null || row.authMethod !== "PASSWORD") {
    return null;
  }
  try {
    const blob = decryptJson<PasswordCredsBlob>(row.encryptedTokens);
    if (blob.kind !== "password" || !blob.username || !blob.password) {
      return null;
    }
    return blob;
  } catch {
    return null;
  }
}

/**
 * Insert or replace per-Member IMAP credentials. Soft-revokes any
 * prior active auth for the same (channel, membership) pair (item
 * 104 invariant), then writes a fresh row.
 *
 * The new row's `nextReauthAt` is `now + tenantReauthDays` —
 * resolved via `resolveCronThresholds` so per-tenant overrides
 * (item 100) take effect.
 *
 * Validation: username + password both non-empty; channel must
 * exist on the caller's tenant; channel kind must be `IMAP` (else
 * password creds are meaningless).
 */
export async function setPasswordCreds(input: {
  tenantId: string;
  channelId: string;
  membershipId: string;
  username: string;
  password: string;
  actorMembershipId: string;
}): Promise<{ authId: string; nextReauthAt: Date; isFreshConnect: boolean }> {
  if (!input.username.trim()) {
    throw new ValidationError("username is required.", "invalid_username");
  }
  if (!input.password) {
    throw new ValidationError("password is required.", "invalid_password");
  }
  const channel = await superDb.channel.findUnique({
    where: { id: input.channelId },
    select: { id: true, tenantId: true, kind: true },
  });
  if (!channel) {
    throw new NotFoundError("channel not found");
  }
  if (channel.tenantId !== input.tenantId) {
    throw new NotFoundError("channel not found"); // cross-tenant → 404
  }
  if (channel.kind !== "IMAP") {
    throw new ValidationError(
      `Channel kind "${channel.kind}" does not accept password credentials. Use OAuth for this kind.`,
      "wrong_channel_kind",
    );
  }

  // Determine if this is a fresh connect (no prior auth ever for this
  // membership-channel pair) before we soft-revoke priors.
  const priorActive = await superDb.channelAuth.findFirst({
    where: {
      channelId: input.channelId,
      membershipId: input.membershipId,
      revokedAt: null,
    },
    select: { id: true },
  });
  const isFreshConnect = priorActive === null;

  // Soft-revoke any prior active auth (item 104 invariant: one
  // ACTIVE per (channel, member) pair).
  await revokePriorAuthsForMembership({
    channelId: input.channelId,
    membershipId: input.membershipId,
  });

  const thresholds = await resolveCronThresholds(input.tenantId);
  const nextReauthAt = new Date(
    Date.now() + thresholds.passwordReauthDays * 24 * 60 * 60 * 1000,
  );

  const blob: PasswordCredsBlob = {
    kind: "password",
    username: input.username.trim(),
    password: input.password,
  };
  const created = await superDb.channelAuth.create({
    data: {
      tenantId: input.tenantId,
      channelId: input.channelId,
      membershipId: input.membershipId,
      encryptedTokens: encryptJson(blob),
      scope: null,
      expiresAt: null,
      authMethod: "PASSWORD",
      nextReauthAt,
      lastFailureAt: null,
      lastFailureReason: null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "CHANNEL_PASSWORD_AUTH_REENTERED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ChannelAuth",
    subjectId: created.id,
    payload: {
      channelId: input.channelId,
      channelKind: channel.kind,
      authMethod: "PASSWORD",
      isFreshConnect,
      nextReauthAt: nextReauthAt.toISOString(),
    },
  });

  return { authId: created.id, nextReauthAt, isFreshConnect };
}

/**
 * Per-User extension of their personal `nextReauthAt`. Two
 * invariants enforced:
 *   1. Cannot REDUCE — `requestedNextReauthAt > existing.nextReauthAt`.
 *      Stuart's stated requirement: "user can extend (not reduce)".
 *   2. Cannot dip below the tenant FLOOR — `requestedNextReauthAt
 *      >= now + tenantReauthDays`. Without this, a User on day 100
 *      of a 90-day cycle could "extend" to day 105 (which is only
 *      5 days from now) and effectively bypass the next re-entry.
 *      Extension EXTENDS; it doesn't bypass.
 *
 * Caller MUST gate by `auth.membershipId === ctx.membership.id`
 * (User can only extend their own auth) — enforced at the route
 * layer.
 */
export async function extendReauthDeadline(input: {
  authId: string;
  requestedNextReauthAt: Date;
  actorMembershipId: string;
}): Promise<{ nextReauthAt: Date; deltaDays: number }> {
  const auth = await superDb.channelAuth.findUnique({
    where: { id: input.authId },
    select: {
      id: true,
      tenantId: true,
      membershipId: true,
      authMethod: true,
      nextReauthAt: true,
      revokedAt: true,
      channelId: true,
    },
  });
  if (!auth || auth.revokedAt !== null || auth.authMethod !== "PASSWORD") {
    throw new NotFoundError("auth not found");
  }
  if (auth.membershipId !== input.actorMembershipId) {
    throw new ForbiddenError("only the auth owner can extend their re-auth deadline");
  }
  if (!auth.nextReauthAt) {
    throw new ValidationError(
      "auth has no current nextReauthAt — cannot extend.",
      "no_current_deadline",
    );
  }

  if (input.requestedNextReauthAt <= auth.nextReauthAt) {
    throw new ValidationError(
      `Re-auth deadline can be extended LATER but never reduced. Current: ${auth.nextReauthAt.toISOString()}; requested: ${input.requestedNextReauthAt.toISOString()}.`,
      "cannot_reduce_deadline",
    );
  }

  const thresholds = await resolveCronThresholds(auth.tenantId);
  const floor = new Date(
    Date.now() + thresholds.passwordReauthDays * 24 * 60 * 60 * 1000,
  );
  if (input.requestedNextReauthAt < floor) {
    throw new ValidationError(
      `Extension must be at least ${thresholds.passwordReauthDays} days from now (the tenant floor). Requested ${input.requestedNextReauthAt.toISOString()}; floor ${floor.toISOString()}.`,
      "below_tenant_floor",
    );
  }

  const priorReauthAt = auth.nextReauthAt;
  await superDb.channelAuth.update({
    where: { id: auth.id },
    data: { nextReauthAt: input.requestedNextReauthAt },
  });

  const deltaDays = Math.round(
    (input.requestedNextReauthAt.getTime() - priorReauthAt.getTime()) /
      (24 * 60 * 60 * 1000),
  );
  await writeAuditEvent({
    tenantId: auth.tenantId,
    eventType: "CHANNEL_PASSWORD_REAUTH_EXTENDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ChannelAuth",
    subjectId: auth.id,
    payload: {
      channelId: auth.channelId,
      authId: auth.id,
      priorReauthAt: priorReauthAt.toISOString(),
      nextReauthAt: input.requestedNextReauthAt.toISOString(),
      deltaDays,
    },
  });

  return { nextReauthAt: input.requestedNextReauthAt, deltaDays };
}

/**
 * Called by `runIngest`'s per-Member catch when `ImapAuthError`
 * (item 110) fires from the IMAP adapter. Stamps `lastFailureAt`
 * + reason on the auth, writes the audit, fires the mandatory
 * `channel_auth_failed` notification (deduped per-day so a
 * chronic failure loop doesn't flood the inbox).
 *
 * Idempotent within the dedupe window — calling repeatedly within
 * the same calendar day re-stamps `lastFailureAt` (so the
 * /account UI shows the FRESHEST failure time) but the
 * notification dispatch is a no-op via the dispatch table's
 * unique constraint.
 *
 * Best-effort on the audit + notification side via reportError —
 * the load-bearing side effect is the `lastFailureAt` stamp,
 * which gates the /account inline prompt + cron re-auth warning.
 */
export async function markPasswordAuthFailed(input: {
  authId: string;
  reason: string;
}): Promise<void> {
  const auth = await superDb.channelAuth.findUnique({
    where: { id: input.authId },
    include: {
      channel: { select: { kind: true, tenantId: true } },
      membership: { include: { user: { select: { email: true } } } },
    },
  });
  if (!auth || auth.authMethod !== "PASSWORD" || auth.revokedAt !== null) {
    return; // nothing to mark
  }

  const now = new Date();
  await superDb.channelAuth.update({
    where: { id: auth.id },
    data: {
      lastFailureAt: now,
      lastFailureReason: input.reason.slice(0, 500),
    },
  });

  try {
    await writeAuditEvent({
      tenantId: auth.tenantId,
      eventType: "CHANNEL_PASSWORD_AUTH_FAILED",
      actorMembershipId: null,
      subjectType: "ChannelAuth",
      subjectId: auth.id,
      payload: {
        channelId: auth.channelId,
        authId: auth.id,
        membershipId: auth.membershipId,
        reason: input.reason.slice(0, 500),
      },
    });
  } catch (e) {
    reportError(
      e,
      {
        route: "lib/channels/password-creds.markPasswordAuthFailed",
        tenantId: auth.tenantId,
        extra: { authId: auth.id },
      },
      "audit write failed for CHANNEL_PASSWORD_AUTH_FAILED",
    );
  }

  if (auth.membership && auth.membership.user.email) {
    // dedupeKey: per-day. A chronic failure loop (every 5min ingest
    // tick keeps trying) re-fires the dispatch table once per day,
    // which the unique constraint short-circuits — one row per
    // (membership, kind, day) is enough to surface the failure.
    const day = now.toISOString().slice(0, 10);
    try {
      await dispatchNotification({
        tenantId: auth.tenantId,
        membershipId: auth.membership.id,
        toEmail: auth.membership.user.email,
        kind: "channel_auth_failed",
        dedupeKey: `auth-failed:${auth.id}:${day}`,
        subject: `Mailbox connection broken — re-enter password`,
        summary: `Your ${auth.channel.kind} mailbox stopped accepting credentials. Re-enter your password on /account to resume ingest.`,
        text:
          `Your ${auth.channel.kind} mailbox connection is no longer working — most often this means you reset your provider password recently.\n\n` +
          `Reason from server: ${input.reason.slice(0, 200)}\n\n` +
          `Open /account, find your ${auth.channel.kind} connection, and re-enter your username + password to resume ingest. ` +
          `Until you do, no inbound or outbound from this mailbox will be analysed.`,
        href: `/account`,
        payload: {
          channelId: auth.channelId,
          authId: auth.id,
          channelKind: auth.channel.kind,
        },
      });
    } catch (e) {
      reportError(
        e,
        {
          route: "lib/channels/password-creds.markPasswordAuthFailed",
          tenantId: auth.tenantId,
          extra: { authId: auth.id, dispatch: "channel_auth_failed" },
        },
        "channel_auth_failed dispatch failed",
      );
    }
  }
}

/**
 * Clear `lastFailureAt` + reason on a successful re-entry.
 * Idempotent on already-cleared rows. Called by `setPasswordCreds`
 * after the new row is created (the OLD row gets revoked, so this
 * is mostly defensive — but a Member who reconnects without first
 * revoking would have stale failure state on the new row otherwise).
 */
export async function clearPasswordAuthFailure(authId: string): Promise<void> {
  await superDb.channelAuth.updateMany({
    where: { id: authId, lastFailureAt: { not: null } },
    data: { lastFailureAt: null, lastFailureReason: null },
  });
}
