import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { maskIp } from "@/lib/auth/sessions/ip";
import { describeUserAgent } from "@/lib/auth/sessions/ua";
import { dispatchSignInNewDevice } from "@/lib/notifications/immediate";
import {
  classifySignIn,
  DEFAULT_LOOKBACK_DAYS,
  type ClassifyResult,
} from "./classify";

/**
 * Sign-in anomaly detector — runs after `observeSessionMetadata` has lazily
 * populated UA + IP on a brand-new session row. Classifies the session
 * against the User's prior 90-day history, and on `'new-device'` writes
 * `SIGN_IN_NEW_DEVICE` to the audit chain + dispatches an in-app + email
 * notification to the User's primary active tenant.
 *
 * Idempotent on `Session.id` via the notification dispatcher's
 * `(membershipId, kind, dedupeKey)` UNIQUE constraint AND a `findFirst`
 * audit-event probe — so re-observing the same session can't double-emit.
 *
 * Returns the classification so the caller (a test, an admin tool) can
 * inspect; in the layout path the result is unused.
 *
 * Fire-and-forget at the call site under `reportError` — a notification
 * mailer hiccup must NEVER block a User from reaching their tenant page.
 */
export type DetectInput = {
  sessionId: string;
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
};

export type DetectResult = {
  classification: ClassifyResult;
  emitted: boolean;
};

export async function detectAndNotify(input: DetectInput): Promise<DetectResult> {
  // Caller may pass nullish UA/IP if the request hadn't carried headers yet.
  // No UA + no IP → no signal to classify, return as 'first-session' silent.
  if (!input.userAgent && !input.ipAddress) {
    return {
      classification: {
        kind: "first-session",
        reasons: [],
        currentFamily: "Unknown/Unknown",
        currentIpBlock: null,
      },
      emitted: false,
    };
  }

  const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const prior = await superDb.session.findMany({
    where: {
      userId: input.userId,
      id: { not: input.sessionId },
      createdAt: { gte: since },
      // We want prior sessions that ACTUALLY signed in from a device — a row
      // with no UA captured is useless for matching, skip it.
      OR: [{ userAgent: { not: null } }, { ipAddress: { not: null } }],
    },
    select: { userAgent: true, ipAddress: true },
    take: 200,
  });

  const classification = classifySignIn({
    currentUserAgent: input.userAgent,
    currentIp: input.ipAddress,
    priorSessions: prior,
  });

  if (classification.kind !== "new-device") {
    return { classification, emitted: false };
  }

  // Resolve the routing tenant: SIGN_IN_NEW_DEVICE is per-User; sessions are
  // per-User-global. Land the audit + notification on the User's primary
  // ACTIVE membership tenant (oldest by joinedAt), same fallback used by
  // session-timeout revocations.
  const routing = await superDb.membership.findFirst({
    where: { userId: input.userId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    select: { id: true, tenantId: true, user: { select: { email: true } } },
  });
  if (!routing) {
    // User has no active membership anywhere — emit nothing; the layout
    // gate will redirect them out on the next pass anyway.
    return { classification, emitted: false };
  }

  // Idempotency: another concurrent classification (e.g. two near-parallel
  // layout passes during page-load) MUST NOT double-emit. Check whether the
  // audit event for this session already exists before writing.
  const existing = await superDb.auditEvent.findFirst({
    where: {
      tenantId: routing.tenantId,
      eventType: "SIGN_IN_NEW_DEVICE",
      subjectType: "Session",
      subjectId: input.sessionId,
    },
    select: { id: true },
  });
  if (existing) {
    return { classification, emitted: false };
  }

  const device = describeUserAgent(input.userAgent ?? null);
  const ipMasked = maskIp(input.ipAddress ?? null);

  await writeAuditEvent({
    tenantId: routing.tenantId,
    eventType: "SIGN_IN_NEW_DEVICE",
    actorMembershipId: null,
    subjectType: "Session",
    subjectId: input.sessionId,
    payload: {
      userId: input.userId,
      sessionId: input.sessionId,
      deviceLabel: device.label,
      browser: device.browser,
      os: device.os,
      ipMasked,
      reasons: classification.reasons,
      family: classification.currentFamily,
      ipBlock: classification.currentIpBlock,
    },
  });

  // Notify the User on the primary tenant. Fire-and-forget; dispatcher
  // already swallows mailer failures via reportError.
  try {
    if (routing.user.email) {
      await dispatchSignInNewDevice({
        tenantId: routing.tenantId,
        membershipId: routing.id,
        toEmail: routing.user.email,
        sessionId: input.sessionId,
        deviceLabel: device.label,
        ipMasked,
        reasons: classification.reasons,
      });
    }
  } catch (err) {
    reportError(err, { extra: { scope: "anomaly:dispatch", sessionId: input.sessionId } });
  }

  return { classification, emitted: true };
}
