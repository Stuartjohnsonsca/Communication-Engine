import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 104 — per-staff-member self-service OAuth.
 *
 * Helpers for the per-Membership ChannelAuth lifecycle that supplement
 * the existing `connect` + `oauth-callback` routes. ChannelAuth
 * already carries `membershipId` (item 3 wired this when the OAuth
 * state was hardened), but until item 104 the rest of the platform
 * only ever surfaced ONE auth per Channel (the most-recent) — see the
 * `take: 1` in `lib/channels/ingest.ts` before the item-104 refactor.
 *
 * After item 104:
 *   - Each Membership of the tenant can have their OWN active
 *     ChannelAuth on each tenant Channel (Gmail mailbox, Outlook,
 *     Teams, etc.). The Channel is the FIRM_ADMIN-managed container;
 *     the auth is per-staff-member.
 *   - Ingest iterates EVERY active per-Member auth on a channel and
 *     fans out adapter calls per-Member.
 *   - Self-revoke from /account writes a `CHANNEL_DEAUTHORISED`
 *     audit row with `byActor: "self"`.
 *   - Admin force-revoke from /admin/channels writes the same audit
 *     type with `byActor: "admin"` so the chain reader can correlate
 *     "Carol's auth was revoked Tuesday" with "the FIRM_ADMIN
 *     force-revoked her on Tuesday after she left the firm."
 */

export type MemberAuthStatus = {
  channelId: string;
  channelKind: string;
  /// Active = `revokedAt: null`. The most-recent active auth per
  /// (channel, membership) — see invariant below.
  authId: string | null;
  connectedAt: Date | null;
  expiresAt: Date | null;
  scope: string | null;
};

/**
 * List the auth status for ONE Membership across every tenant
 * Channel — what /account renders for "your connected provider
 * accounts". Returns a row per Channel even when no auth exists, so
 * the page can show a Connect button for every kind the tenant has
 * a Channel for.
 *
 * **Invariant: most-recent ACTIVE auth wins per (channel, membership).**
 * Multiple ACTIVE rows for the same (channel, membership) pair would
 * make ingest non-deterministic — adapter call would arbitrarily
 * pick one. Per item 104 ingest iterates all (channelId, revokedAt:
 * null) auths PARTITIONED by membershipId, so duplicate ACTIVE rows
 * for one Member would cause the same mailbox to be polled twice.
 * Today no schema constraint enforces uniqueness (history is
 * preserved by leaving revoked rows in place); the connect route
 * MUST soft-revoke any prior active row for (channel, membership)
 * before inserting a new one. See `connect` route's revoke-prior
 * step.
 */
export async function listChannelAuthsForMembership(input: {
  tenantId: string;
  membershipId: string;
}): Promise<MemberAuthStatus[]> {
  const channels = await superDb.channel.findMany({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: "asc" },
  });
  const results: MemberAuthStatus[] = [];
  for (const c of channels) {
    const auth = await superDb.channelAuth.findFirst({
      where: {
        channelId: c.id,
        membershipId: input.membershipId,
        revokedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    results.push({
      channelId: c.id,
      channelKind: c.kind,
      authId: auth?.id ?? null,
      connectedAt: auth?.createdAt ?? null,
      expiresAt: auth?.expiresAt ?? null,
      scope: auth?.scope ?? null,
    });
  }
  return results;
}

/**
 * List all ACTIVE per-Member auths on a channel — what
 * /admin/channels renders as the per-Member roster. Includes the
 * Membership label (User name + email) for the UI.
 */
export async function listActiveAuthsForChannel(input: {
  tenantId: string;
  channelId: string;
}): Promise<
  Array<{
    authId: string;
    membershipId: string;
    memberName: string;
    memberEmail: string | null;
    connectedAt: Date;
    expiresAt: Date | null;
    scope: string | null;
  }>
> {
  const rows = await superDb.channelAuth.findMany({
    where: {
      channelId: input.channelId,
      revokedAt: null,
      membershipId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    include: {
      membership: {
        select: {
          id: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
  return rows
    .filter((r) => r.membership)
    .map((r) => ({
      authId: r.id,
      membershipId: r.membership!.id,
      memberName: r.membership!.user.name ?? r.membership!.user.email ?? "(unknown)",
      memberEmail: r.membership!.user.email,
      connectedAt: r.createdAt,
      expiresAt: r.expiresAt,
      scope: r.scope,
    }));
}

/**
 * Soft-revoke one ChannelAuth row (sets `revokedAt`). Idempotent on
 * an already-revoked auth (no-op, no audit, no error). Writes a
 * `CHANNEL_DEAUTHORISED` audit row whose `byActor` field
 * disambiguates self-revoke vs admin-force-revoke for chain
 * readers.
 *
 * Caller MUST gate the action by:
 *   - byActor=self → caller's membershipId === auth.membershipId
 *     (the User is revoking their own connection); RBAC permission
 *     `channels:connect-own`.
 *   - byActor=admin → caller has `channels:write` (FIRM_ADMIN);
 *     auth.membershipId can be any Membership in the tenant.
 *
 * Tenant scoping: this lib does NOT verify the auth belongs to the
 * caller's tenant — caller must enforce. The route handlers do this
 * via `getTenantContext` + the auth's tenantId field.
 */
export async function revokeChannelAuth(input: {
  authId: string;
  byActor: "self" | "admin";
  actorMembershipId: string;
  reason?: string;
}): Promise<{ revoked: boolean }> {
  const auth = await superDb.channelAuth.findUnique({
    where: { id: input.authId },
    include: { channel: { select: { kind: true, tenantId: true } } },
  });
  if (!auth) return { revoked: false };
  if (auth.revokedAt !== null) return { revoked: false }; // already revoked

  await superDb.channelAuth.update({
    where: { id: input.authId },
    data: { revokedAt: new Date() },
  });

  // Best-effort audit; failures are logged via reportError but the
  // revoke side effect (ingest will stop using these tokens) is the
  // load-bearing fact and must not roll back on a transient audit
  // write failure.
  try {
    await writeAuditEvent({
      tenantId: auth.tenantId,
      eventType: "CHANNEL_DEAUTHORISED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "ChannelAuth",
      subjectId: input.authId,
      payload: {
        channelId: auth.channelId,
        channelKind: auth.channel.kind,
        membershipId: auth.membershipId,
        byActor: input.byActor,
        reason: input.reason ?? null,
      },
    });
  } catch (e) {
    reportError(
      e,
      {
        route: "lib/channels/auths.revokeChannelAuth",
        tenantId: auth.tenantId,
        extra: { authId: input.authId, byActor: input.byActor },
      },
      "channel-deauthorised audit write failed",
    );
  }

  return { revoked: true };
}

/**
 * Soft-revoke ALL prior ACTIVE auths for a (channel, membership)
 * pair. Called by the OAuth callback route BEFORE inserting the
 * fresh ChannelAuth — preserves history (soft-delete via revokedAt,
 * row stays for audit) but ensures only one active auth per
 * (channel, membership) at any time.
 *
 * Without this step, a User who re-connects their Gmail (e.g. after
 * a token-refresh failure) would accumulate stale ACTIVE rows; ingest
 * would have to pick one arbitrarily and could end up using the old
 * (revoked-at-the-provider-side) tokens.
 *
 * Returns the count of rows that were revoked.
 */
export async function revokePriorAuthsForMembership(input: {
  channelId: string;
  membershipId: string;
}): Promise<{ revokedCount: number }> {
  const result = await superDb.channelAuth.updateMany({
    where: {
      channelId: input.channelId,
      membershipId: input.membershipId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return { revokedCount: result.count };
}
