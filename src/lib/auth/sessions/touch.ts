import { superDb } from "@/lib/db";

const TOUCH_INTERVAL_MS = 60_000; // throttle lastSeenAt updates to ≤ 1/min.

/**
 * Touch `Session.lastSeenAt` for the given session id, capping at one write
 * per `TOUCH_INTERVAL_MS` to keep the write rate sane on hot tenant pages.
 *
 * Conditional UPDATE on `lastSeenAt < now() - interval` so concurrent calls
 * collapse into a single write inside the database. If the row doesn't
 * exist or is already revoked we no-op (the layout-level gate will catch
 * the revocation on the next request).
 */
export async function touchSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await superDb.$executeRaw`
    UPDATE "Session"
       SET "lastSeenAt" = NOW()
     WHERE "id" = ${sessionId}
       AND "revokedAt" IS NULL
       AND "lastSeenAt" < (NOW() - (${TOUCH_INTERVAL_MS}::int * INTERVAL '1 millisecond'))
  `;
}

/**
 * Lazy-populate `userAgent` / `ipAddress` on first observation. Both fields
 * are set together inside one UPDATE that only fires when BOTH columns are
 * still null — keeps the original capture immutable so a later request with
 * spoofed headers can't rewrite the row.
 *
 * The PrismaAdapter `createSession` path doesn't have access to the request
 * headers (NextAuth invokes it from a callback that only carries the user +
 * provider), which is why we capture lazily from the tenant layout on the
 * very next request after sign-in.
 */
export async function observeSessionMetadata(
  sessionId: string,
  userAgent: string | null | undefined,
  ipAddress: string | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  const ua = userAgent && userAgent.length > 0 ? userAgent.slice(0, 512) : null;
  const ip = ipAddress && ipAddress.length > 0 ? ipAddress.slice(0, 64) : null;
  if (!ua && !ip) return;
  await superDb.$executeRaw`
    UPDATE "Session"
       SET "userAgent" = COALESCE("userAgent", ${ua}),
           "ipAddress" = COALESCE("ipAddress", ${ip})
     WHERE "id" = ${sessionId}
       AND "revokedAt" IS NULL
       AND ("userAgent" IS NULL OR "ipAddress" IS NULL)
  `;
}
