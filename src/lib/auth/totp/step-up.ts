import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import type { AuditEventType } from "@prisma/client";

/**
 * Step-up authentication evaluator. Sensitive operations call
 * `requireStepUp(opts)` immediately before mutating; if the User's
 * TOTP verification stamp is older than the freshness window (or
 * missing entirely, or the User has no TOTP enrolled), the call
 * throws `StepUpRequired` and the caller redirects to
 * `/auth/2fa?stepUp=1&next=<original-url>&op=<op-key>`.
 *
 * Default freshness window is 5 minutes. A tenant may override via
 * `Tenant.stepUpMaxAgeMinutes`. Cross-tenant Users get the strictest
 * non-null value across their active memberships — same posture as
 * session timeouts (item 15), conservative-wins.
 *
 * Step-up is NOT skipped when `Tenant.requireTotp` is false. The
 * point of step-up is that certain operations always require fresh
 * verification regardless of tenant-wide policy. If a User has no
 * TOTP enrolled, they cannot perform the gated operation until they
 * enroll.
 */

export const DEFAULT_STEP_UP_MAX_AGE_MINUTES = 5;
export const MIN_STEP_UP_MAX_AGE_MINUTES = 1;
export const MAX_STEP_UP_MAX_AGE_MINUTES = 60;

export type StepUpStatus = "fresh" | "stale" | "no-totp";

export type EvaluateStepUpInput = {
  sessionId: string | null;
  userId: string;
  /** Single-tenant convenience — pass the resolved tenant's override. */
  tenantStepUpMaxAgeMinutes?: number | null;
  /** For cross-tenant: pre-resolved effective window in minutes. */
  effectiveMaxAgeMinutes?: number;
  now?: Date;
};

export type EvaluateStepUpResult = {
  status: StepUpStatus;
  /** Age of the existing verification stamp in minutes (Infinity if none). */
  ageMinutes: number;
  /** Effective freshness window applied. */
  maxAgeMinutes: number;
};

export async function evaluateStepUp(input: EvaluateStepUpInput): Promise<EvaluateStepUpResult> {
  const now = (input.now ?? new Date()).getTime();
  const maxAgeMinutes =
    input.effectiveMaxAgeMinutes ??
    input.tenantStepUpMaxAgeMinutes ??
    DEFAULT_STEP_UP_MAX_AGE_MINUTES;

  // Cheap parallel read — UserTotp enrollment + Session stamp. Both
  // already exist; this gate is read-only.
  const [totp, session] = await Promise.all([
    superDb.userTotp.findUnique({
      where: { userId: input.userId },
      select: { verifiedAt: true, disabledAt: true },
    }),
    input.sessionId
      ? superDb.session.findUnique({
          where: { id: input.sessionId },
          select: { totpVerifiedAt: true },
        })
      : Promise.resolve(null),
  ]);

  const enrolled = !!totp?.verifiedAt && !totp.disabledAt;
  if (!enrolled) {
    return { status: "no-totp", ageMinutes: Number.POSITIVE_INFINITY, maxAgeMinutes };
  }

  const stamp = session?.totpVerifiedAt;
  if (!stamp) {
    return { status: "stale", ageMinutes: Number.POSITIVE_INFINITY, maxAgeMinutes };
  }
  const ageMinutes = (now - stamp.getTime()) / 60_000;
  if (ageMinutes <= maxAgeMinutes) {
    return { status: "fresh", ageMinutes, maxAgeMinutes };
  }
  return { status: "stale", ageMinutes, maxAgeMinutes };
}

/**
 * For a User who has memberships in multiple tenants: resolve the
 * strictest non-null `stepUpMaxAgeMinutes`. Empty / all-null means
 * the platform default applies. INACTIVE memberships are ignored —
 * they don't get to influence the live policy.
 */
export async function resolveEffectiveStepUpWindow(userId: string): Promise<{
  maxAgeMinutes: number;
  bindingTenantIds: string[];
}> {
  const memberships = await superDb.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { tenantId: true, tenant: { select: { stepUpMaxAgeMinutes: true } } },
  });
  const candidates: Array<{ tenantId: string; value: number }> = [];
  for (const m of memberships) {
    const v = m.tenant.stepUpMaxAgeMinutes;
    if (typeof v === "number") candidates.push({ tenantId: m.tenantId, value: v });
  }
  if (candidates.length === 0) {
    return { maxAgeMinutes: DEFAULT_STEP_UP_MAX_AGE_MINUTES, bindingTenantIds: [] };
  }
  const min = candidates.reduce((acc, c) => (c.value < acc.value ? c : acc));
  const binding = candidates.filter((c) => c.value === min.value).map((c) => c.tenantId);
  return { maxAgeMinutes: min.value, bindingTenantIds: binding };
}

export class StepUpRequired extends Error {
  status = 401;
  constructor(
    public readonly nextUrl: string,
    public readonly opKey: string,
    public readonly reason: "stale" | "no-totp",
  ) {
    super(`step-up authentication required for ${opKey} (${reason})`);
    this.name = "StepUpRequired";
  }
}

/**
 * Helper for server actions. Evaluates step-up and throws
 * `StepUpRequired` on stale or no-totp; the caller catches and
 * redirects to the URL on the error.
 *
 * `opKey` identifies the operation in the audit chain and in the
 * step-up page's friendly label. Use a kebab-case noun phrase:
 * `ip-allowlist-change`, `api-key-create`, etc.
 *
 * `nextUrl` is where to send the User after a successful step-up
 * challenge — usually the page they came from so they can re-submit
 * the form. Caller is responsible for sanitisation (see the
 * /auth/2fa page's `sanitiseNext` helper).
 */
export async function requireStepUp(opts: {
  sessionId: string | null;
  userId: string;
  tenantStepUpMaxAgeMinutes?: number | null;
  /** Where to redirect after successful step-up. */
  nextUrl: string;
  /** Operation identifier — kebab-case, audited. */
  opKey: string;
}): Promise<void> {
  const result = await evaluateStepUp({
    sessionId: opts.sessionId,
    userId: opts.userId,
    tenantStepUpMaxAgeMinutes: opts.tenantStepUpMaxAgeMinutes,
  });
  if (result.status === "fresh") return;
  throw new StepUpRequired(opts.nextUrl, opts.opKey, result.status);
}

/**
 * Write a STEP_UP_VERIFIED audit row on a successful step-up
 * challenge. Called by the /auth/2fa page in step-up mode after the
 * verify or recovery-code call succeeds. Separate audit event from
 * the regular TOTP_VERIFIED so an audit reviewer can scan for
 * step-ups specifically.
 */
export async function recordStepUpVerified(opts: {
  tenantId: string;
  actorMembershipId: string;
  opKey: string;
  /** Optional: hint for the subject id of the about-to-happen op. */
  subjectId?: string;
  subjectType?: string;
}): Promise<void> {
  const eventType: AuditEventType = "STEP_UP_VERIFIED";
  await writeAuditEvent({
    tenantId: opts.tenantId,
    eventType,
    actorMembershipId: opts.actorMembershipId,
    subjectType: opts.subjectType ?? "Membership",
    subjectId: opts.subjectId ?? opts.actorMembershipId,
    payload: { opKey: opts.opKey },
  });
}
