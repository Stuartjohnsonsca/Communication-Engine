import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

export type RevokeReason = "user-self" | "admin-revoke" | "admin-revoke-all";

type RevokeContext = {
  tenantId: string;
  actorMembershipId: string;
  actorUserId: string;
};

/**
 * Revoke a single session by id. Sets `revokedAt` / `revokedById` /
 * `revokedReason`; the wrapped PrismaAdapter (`src/lib/auth.ts`) treats any
 * row with `revokedAt IS NOT NULL` as signed-out, so the affected device
 * loses access on its next request.
 *
 * Returns the targetUserId for the caller's downstream logic.
 *
 * Caller is responsible for the permission check:
 *   * User revoking their own session: `auth:revoke-own-sessions` AND
 *     the session's `userId === ctx.actorUserId`.
 *   * Firm Admin revoking a member's session: `tenant:revoke-member-sessions`
 *     AND the session's owner has an ACTIVE membership in `ctx.tenantId`.
 *
 * The audit event is written against `ctx.tenantId` regardless of which
 * tenant the session was created in — the audit chain is per-tenant, and
 * the *originating actor's* tenant is the one with the security-relevant
 * context for the revocation.
 */
export async function revokeSession(opts: {
  sessionId: string;
  reason: RevokeReason;
  ctx: RevokeContext;
}): Promise<{ revoked: boolean; targetUserId: string | null }> {
  const row = await superDb.session.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!row) return { revoked: false, targetUserId: null };
  if (row.revokedAt) return { revoked: false, targetUserId: row.userId };

  await superDb.session.update({
    where: { id: row.id },
    data: {
      revokedAt: new Date(),
      revokedById: opts.ctx.actorUserId,
      revokedReason: opts.reason,
    },
  });

  const isAdmin = opts.reason !== "user-self";
  await writeAuditEvent({
    tenantId: opts.ctx.tenantId,
    eventType: isAdmin ? "SESSION_REVOKED_BY_ADMIN" : "SESSION_REVOKED",
    actorMembershipId: opts.ctx.actorMembershipId,
    subjectType: "Session",
    subjectId: row.id,
    payload: {
      targetUserId: row.userId,
      reason: opts.reason,
    },
  });

  return { revoked: true, targetUserId: row.userId };
}

/**
 * Revoke every active session belonging to a given User. Used by:
 *   * User signing themselves out everywhere (a "Sign out all other devices"
 *     button on /account — does NOT revoke the actor's own session, the
 *     caller should pass `excludeSessionId` for that affordance).
 *   * Firm Admin revoking everything for a compromised member.
 *
 * Returns the count of newly-revoked rows; a single `SESSION_REVOKED_ALL`
 * audit event carrying the count + targetUserId is written.
 */
export async function revokeAllSessionsForUser(opts: {
  targetUserId: string;
  reason: RevokeReason;
  ctx: RevokeContext;
  excludeSessionId?: string | null;
}): Promise<{ revoked: number }> {
  const now = new Date();
  const where = {
    userId: opts.targetUserId,
    revokedAt: null as Date | null,
    ...(opts.excludeSessionId ? { NOT: { id: opts.excludeSessionId } } : {}),
  };
  const result = await superDb.session.updateMany({
    where,
    data: {
      revokedAt: now,
      revokedById: opts.ctx.actorUserId,
      revokedReason: opts.reason,
    },
  });

  if (result.count > 0) {
    await writeAuditEvent({
      tenantId: opts.ctx.tenantId,
      eventType: "SESSION_REVOKED_ALL",
      actorMembershipId: opts.ctx.actorMembershipId,
      subjectType: "User",
      subjectId: opts.targetUserId,
      payload: {
        reason: opts.reason,
        revokedCount: result.count,
        excludeSessionId: opts.excludeSessionId ?? null,
      },
    });
  }

  return { revoked: result.count };
}
