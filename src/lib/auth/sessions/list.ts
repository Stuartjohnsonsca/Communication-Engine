import { superDb } from "@/lib/db";
import { describeUserAgent, type DeviceSummary } from "./ua";

export type SessionRow = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expires: Date;
  userAgent: string | null;
  ipAddress: string | null;
  totpVerifiedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  isCurrent: boolean;
  device: DeviceSummary;
};

/**
 * Return every Session for a User. Includes revoked rows so the User has a
 * forensic record of what was signed in when and what was force-signed-out.
 * The caller marks the current session by passing the active session id.
 */
export async function listSessionsForUser(opts: {
  userId: string;
  currentSessionId: string | null;
  includeRevoked?: boolean;
}): Promise<SessionRow[]> {
  const rows = await superDb.session.findMany({
    where: {
      userId: opts.userId,
      ...(opts.includeRevoked ? {} : { revokedAt: null }),
    },
    orderBy: [{ revokedAt: "asc" }, { lastSeenAt: "desc" }],
    select: {
      id: true,
      userId: true,
      createdAt: true,
      lastSeenAt: true,
      expires: true,
      userAgent: true,
      ipAddress: true,
      totpVerifiedAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    isCurrent: opts.currentSessionId !== null && r.id === opts.currentSessionId,
    device: describeUserAgent(r.userAgent),
  }));
}

/**
 * Return every active session for every User who has an ACTIVE membership
 * in the given tenant. Used by the admin security console for incident
 * response: a FIRM_ADMIN of tenant X can see and revoke sessions for any
 * member of tenant X — note that revoking signs the User out *globally*
 * (sessions are per-User not per-Membership; this is correct for incident
 * response — if creds are compromised, sign out everywhere).
 */
export async function listActiveSessionsInTenant(tenantId: string): Promise<
  Array<{
    user: { id: string; email: string; name: string | null };
    role: string;
    sessions: SessionRow[];
  }>
> {
  const memberships = await superDb.membership.findMany({
    where: { tenantId, status: "ACTIVE" },
    select: {
      role: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
  const out: Array<{
    user: { id: string; email: string; name: string | null };
    role: string;
    sessions: SessionRow[];
  }> = [];
  for (const m of memberships) {
    const sessions = await listSessionsForUser({
      userId: m.user.id,
      currentSessionId: null,
      includeRevoked: false,
    });
    if (sessions.length === 0) continue;
    out.push({ user: m.user, role: m.role, sessions });
  }
  return out;
}
