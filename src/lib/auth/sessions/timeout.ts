import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Post-PRD hardening item 15 — idle + absolute session timeout.
 *
 * Two thresholds, both configurable per tenant:
 *
 *   * Idle timeout: maximum gap between now and `Session.lastSeenAt`. The
 *     layout updates `lastSeenAt` (throttled to 1/min by `touchSession`)
 *     on every authenticated tenant page load, so a User who closes their
 *     laptop and walks away will be auto-signed-out the first time the
 *     gap exceeds the threshold — either when they come back and reach
 *     the layout (which evaluates the gate before rendering), or via the
 *     periodic cron sweep below if they don't come back at all.
 *
 *   * Absolute timeout: maximum gap between now and `Session.createdAt`,
 *     irrespective of activity. A forgotten signed-in browser eventually
 *     expires regardless of how often it's been ticked. Enterprise
 *     procurement reviewers ask for this; NIST SP 800-63B Rev.3 §7.2
 *     recommends it.
 *
 * Cross-tenant policy: the same `Session.userId` may have ACTIVE memberships
 * in multiple tenants. Sessions are per-User-global, so we apply the
 * STRICTEST tenant's policy along each dimension (min idle, min absolute).
 * This is conservative and safe; a slack tenant cannot loosen a stricter
 * tenant's posture. Null on either column means "inherit the platform
 * default" — we compute the minimum across non-null policies plus the
 * defaults.
 */

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
export const DEFAULT_ABSOLUTE_TIMEOUT_MINUTES = 24 * 60;

export const MIN_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_IDLE_TIMEOUT_MINUTES = 24 * 60;
export const MIN_ABSOLUTE_TIMEOUT_MINUTES = 30;
export const MAX_ABSOLUTE_TIMEOUT_MINUTES = 30 * 24 * 60;

export type TimeoutPolicy = {
  /** Effective idle limit in minutes after cross-tenant min. */
  idleLimitMinutes: number;
  /** Effective absolute limit in minutes after cross-tenant min. */
  absoluteLimitMinutes: number;
  /**
   * Tenant ids whose explicit (non-null) policy contributed to the
   * effective idle threshold. Empty array means every tenant inherits
   * the platform default for idle. The first entry is the binding
   * tenant when writing audit on revocation.
   */
  idleBindingTenantIds: string[];
  /** Same for the absolute threshold. */
  absoluteBindingTenantIds: string[];
};

/**
 * Resolve the effective per-User policy by walking active memberships and
 * taking the minimum non-null tenant value along each dimension. Falls
 * back to the platform default when every membership inherits.
 */
export async function resolvePolicyForUser(userId: string): Promise<TimeoutPolicy> {
  const memberships = await superDb.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: {
      tenantId: true,
      tenant: {
        select: {
          sessionIdleTimeoutMinutes: true,
          sessionAbsoluteTimeoutMinutes: true,
        },
      },
    },
  });

  let idleLimit = DEFAULT_IDLE_TIMEOUT_MINUTES;
  let absoluteLimit = DEFAULT_ABSOLUTE_TIMEOUT_MINUTES;
  const idleBinding: string[] = [];
  const absoluteBinding: string[] = [];

  for (const m of memberships) {
    const i = m.tenant.sessionIdleTimeoutMinutes;
    if (i !== null && i > 0) {
      if (i < idleLimit) {
        idleLimit = i;
        idleBinding.length = 0;
        idleBinding.push(m.tenantId);
      } else if (i === idleLimit) {
        idleBinding.push(m.tenantId);
      }
    }
    const a = m.tenant.sessionAbsoluteTimeoutMinutes;
    if (a !== null && a > 0) {
      if (a < absoluteLimit) {
        absoluteLimit = a;
        absoluteBinding.length = 0;
        absoluteBinding.push(m.tenantId);
      } else if (a === absoluteLimit) {
        absoluteBinding.push(m.tenantId);
      }
    }
  }

  return {
    idleLimitMinutes: idleLimit,
    absoluteLimitMinutes: absoluteLimit,
    idleBindingTenantIds: idleBinding,
    absoluteBindingTenantIds: absoluteBinding,
  };
}

export type TimeoutReason = "idle-timeout" | "absolute-timeout";

export type TimeoutEvaluation =
  | { expired: false }
  | {
      expired: true;
      reason: TimeoutReason;
      bindingTenantId: string | null;
      ageMinutes: number;
      limitMinutes: number;
    };

type SessionForEvaluation = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
};

/**
 * Evaluate a single session against the resolved policy. Absolute timeout
 * takes precedence over idle (a session that has been open for 31 days
 * with active touches should report `absolute-timeout`, not `idle-timeout`,
 * so the audit reason matches the real cause). Returns `expired: false`
 * for already-revoked rows so the cron sweep is idempotent.
 */
export function evaluateSession(
  session: SessionForEvaluation,
  policy: TimeoutPolicy,
  now: Date = new Date(),
): TimeoutEvaluation {
  if (session.revokedAt) return { expired: false };
  const nowMs = now.getTime();
  const ageMs = nowMs - session.createdAt.getTime();
  const idleMs = nowMs - session.lastSeenAt.getTime();
  const absoluteLimitMs = policy.absoluteLimitMinutes * 60_000;
  const idleLimitMs = policy.idleLimitMinutes * 60_000;
  if (ageMs >= absoluteLimitMs) {
    return {
      expired: true,
      reason: "absolute-timeout",
      bindingTenantId: policy.absoluteBindingTenantIds[0] ?? null,
      ageMinutes: Math.floor(ageMs / 60_000),
      limitMinutes: policy.absoluteLimitMinutes,
    };
  }
  if (idleMs >= idleLimitMs) {
    return {
      expired: true,
      reason: "idle-timeout",
      bindingTenantId: policy.idleBindingTenantIds[0] ?? null,
      ageMinutes: Math.floor(idleMs / 60_000),
      limitMinutes: policy.idleLimitMinutes,
    };
  }
  return { expired: false };
}

/**
 * System-driven revocation of a single session. Sets `revokedAt`,
 * `revokedReason`; leaves `revokedById` null because there is no User
 * actor. Writes one audit event on the binding tenant's chain (the
 * tenant whose policy was the strictest along the binding dimension);
 * when binding is empty (every tenant inherits default) we write on
 * the User's first active membership tenant if one exists, otherwise
 * no audit is written and the row is still revoked. Idempotent: if the
 * row is already revoked we return without writing.
 */
export async function revokeForTimeout(opts: {
  sessionId: string;
  userId: string;
  reason: TimeoutReason;
  bindingTenantId: string | null;
  ageMinutes: number;
  limitMinutes: number;
}): Promise<{ revoked: boolean }> {
  const row = await superDb.session.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return { revoked: false };

  await superDb.session.update({
    where: { id: row.id },
    data: {
      revokedAt: new Date(),
      revokedById: null,
      revokedReason: opts.reason,
    },
  });

  let tenantIdForAudit = opts.bindingTenantId;
  if (!tenantIdForAudit) {
    const fallback = await superDb.membership.findFirst({
      where: { userId: opts.userId, status: "ACTIVE" },
      orderBy: { joinedAt: "asc" },
      select: { tenantId: true },
    });
    tenantIdForAudit = fallback?.tenantId ?? null;
  }
  if (tenantIdForAudit) {
    await writeAuditEvent({
      tenantId: tenantIdForAudit,
      eventType: "SESSION_REVOKED",
      actorMembershipId: null,
      subjectType: "Session",
      subjectId: row.id,
      payload: {
        reason: opts.reason,
        targetUserId: row.userId,
        ageMinutes: opts.ageMinutes,
        limitMinutes: opts.limitMinutes,
        systemRevocation: true,
      },
    });
  }
  return { revoked: true };
}

/**
 * Evaluate one session and revoke it if expired. Used by the layout-level
 * gate. Returns the evaluation result so the caller can decide whether to
 * redirect to /login. Caches the policy resolution at the call site if
 * needed; the layout calls this once per request, on the single active
 * session, so a per-call DB hit is fine.
 */
export async function enforceSessionTimeout(
  sessionId: string,
): Promise<TimeoutEvaluation> {
  const session = await superDb.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      lastSeenAt: true,
      revokedAt: true,
    },
  });
  if (!session) return { expired: false };
  if (session.revokedAt) return { expired: false };
  const policy = await resolvePolicyForUser(session.userId);
  const result = evaluateSession(session, policy);
  if (result.expired) {
    await revokeForTimeout({
      sessionId: session.id,
      userId: session.userId,
      reason: result.reason,
      bindingTenantId: result.bindingTenantId,
      ageMinutes: result.ageMinutes,
      limitMinutes: result.limitMinutes,
    });
  }
  return result;
}

/**
 * Periodic sweep — revoke every active Session whose policy has been
 * breached, regardless of whether the User has come back since. Run from
 * the lifecycle-sweep cron. Idempotent: already-revoked rows are skipped
 * by the `revokedAt: null` filter; a second run within the same minute
 * finds no eligible rows.
 *
 * Walks sessions in batches by candidate cutoff to avoid loading the whole
 * table. Conservative upper-bound: anything that hasn't been seen in 5
 * minutes OR was created more than 30 days ago is a candidate; the per-User
 * policy then decides whether it's actually expired. Most active sessions
 * have lastSeenAt within the last few minutes so the cutoff lets us skip
 * them with an indexed scan.
 */
export async function sweepExpiredSessions(
  now: Date = new Date(),
): Promise<{ revoked: number; reasons: Record<TimeoutReason, number> }> {
  const candidateCutoff = new Date(
    now.getTime() - MIN_IDLE_TIMEOUT_MINUTES * 60_000,
  );
  const candidates = await superDb.session.findMany({
    where: {
      revokedAt: null,
      OR: [{ lastSeenAt: { lt: candidateCutoff } }, { createdAt: { lt: candidateCutoff } }],
    },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      lastSeenAt: true,
      revokedAt: true,
    },
    take: 2000,
  });
  const policyByUser = new Map<string, TimeoutPolicy>();
  let revoked = 0;
  const reasons: Record<TimeoutReason, number> = {
    "idle-timeout": 0,
    "absolute-timeout": 0,
  };
  for (const s of candidates) {
    let policy = policyByUser.get(s.userId);
    if (!policy) {
      policy = await resolvePolicyForUser(s.userId);
      policyByUser.set(s.userId, policy);
    }
    const result = evaluateSession(s, policy, now);
    if (!result.expired) continue;
    const r = await revokeForTimeout({
      sessionId: s.id,
      userId: s.userId,
      reason: result.reason,
      bindingTenantId: result.bindingTenantId,
      ageMinutes: result.ageMinutes,
      limitMinutes: result.limitMinutes,
    });
    if (r.revoked) {
      revoked += 1;
      reasons[result.reason] += 1;
    }
  }
  return { revoked, reasons };
}
