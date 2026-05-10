import { superDb } from "@/lib/db";

/**
 * The layout-level 2FA gate is the only place the runtime decides whether
 * to redirect the User away from a tenant route to a 2FA flow. Three
 * outcomes:
 *
 *   * `ok`               — let the request through.
 *   * `enroll-required`  — tenant has `requireTotp = true`, User has no
 *                          verified UserTotp; redirect to /[tenant]/account
 *                          to enroll.
 *   * `verify-required`  — User has a verified UserTotp, but the active
 *                          NextAuth Session has no `totpVerifiedAt` stamp;
 *                          redirect to /login/2fa to challenge.
 *
 * This is a pure read of the User + Session + Tenant state. It writes no
 * audit and never mutates anything.
 */

export type GateOutcome = "ok" | "enroll-required" | "verify-required";

export async function evaluateTotpGate({
  userId,
  sessionId,
  tenantRequireTotp,
}: {
  userId: string;
  sessionId: string | null;
  tenantRequireTotp: boolean;
}): Promise<GateOutcome> {
  const [totp, session] = await Promise.all([
    superDb.userTotp.findUnique({
      where: { userId },
      select: { verifiedAt: true, disabledAt: true },
    }),
    sessionId
      ? superDb.session.findUnique({
          where: { id: sessionId },
          select: { totpVerifiedAt: true, expires: true },
        })
      : Promise.resolve(null),
  ]);

  const enrolled = !!totp?.verifiedAt && !totp.disabledAt;

  if (!enrolled) {
    return tenantRequireTotp ? "enroll-required" : "ok";
  }

  // Enrolled — the active session must carry a verification stamp.
  const sessionVerified = !!session?.totpVerifiedAt;
  return sessionVerified ? "ok" : "verify-required";
}

/**
 * NextAuth's database adapter writes the session token to a cookie named
 * (in v5) either `authjs.session-token` or `__Secure-authjs.session-token`.
 * The middleware/layout reads the cookie value (the sessionToken column),
 * NOT the row id; we need the row id to update `totpVerifiedAt`. This
 * helper resolves cookie → row id once per request.
 */
export async function resolveSessionId(sessionToken: string | null): Promise<string | null> {
  if (!sessionToken) return null;
  const row = await superDb.session.findUnique({
    where: { sessionToken },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Read the active NextAuth session cookie + resolve to the Session row id.
 * Returns null when there is no recognisable cookie or the cookie token
 * does not map to a Session row. The cookie name varies depending on
 * deployment (HTTPS production sets `__Secure-authjs.session-token`; plain
 * HTTP dev sets `authjs.session-token`) — try both. v4 used `next-auth.`
 * as the prefix; we keep that too since downgrades happen.
 */
const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

export async function resolveCurrentSessionId(): Promise<string | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const value = store.get(name)?.value;
    if (value) {
      const id = await resolveSessionId(value);
      if (id) return id;
    }
  }
  return null;
}
