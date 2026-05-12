import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { encryptJson, decryptJson } from "@/lib/channels/crypto";
import { generateSecret, provisioningUri } from "./secret";
import { verifyTotp } from "./code";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  findMatchingHashIndex,
  RECOVERY_CODE_COUNT,
} from "./recovery";

/**
 * High-level TOTP lifecycle. Designed so route handlers can call a single
 * function per intent (initiate, verifyEnrollment, verifyChallenge,
 * consumeRecoveryCode, disable) and not worry about audit, encryption, or
 * session stamping.
 *
 * Audit posture: per-User events (enroll, disable, verify, failed verify,
 * recovery-code use) are written against the User's primary ACTIVE
 * membership — deterministic pick (oldest joinedAt) so every event for a
 * given User lands in the same tenant chain. Tenant-policy changes
 * (TENANT_TOTP_REQUIREMENT_CHANGED) are obviously written against the
 * tenant whose policy was changed.
 */

export type EnrollmentInitiation = {
  secretBase32: string;
  otpauthUri: string;
  recoveryCodes: string[];
};

export async function initiateEnrollment({
  userId,
  accountEmail,
  issuer = "Acumon Communications",
}: {
  userId: string;
  accountEmail: string;
  issuer?: string;
}): Promise<EnrollmentInitiation> {
  const secret = generateSecret();
  const codes = generateRecoveryCodes();
  const hashed = codes.map(hashRecoveryCode);
  const enc = encryptJson({ secret });

  // Upsert: if a prior row exists (perhaps disabled), overwrite the secret
  // and recovery codes — re-enrollment starts a clean slate.
  await superDb.userTotp.upsert({
    where: { userId },
    create: {
      userId,
      secretEncrypted: enc,
      recoveryCodesHashed: hashed,
    },
    update: {
      secretEncrypted: enc,
      recoveryCodesHashed: hashed,
      verifiedAt: null,
      disabledAt: null,
      lastUsedAt: null,
    },
  });

  return {
    secretBase32: secret,
    otpauthUri: provisioningUri({ secret, account: accountEmail, issuer }),
    recoveryCodes: codes,
  };
}

export async function verifyEnrollment({
  userId,
  code,
}: {
  userId: string;
  code: string;
}): Promise<{ ok: true } | { ok: false; reason: "not-initiated" | "bad-code" }> {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row) return { ok: false, reason: "not-initiated" };
  const { secret } = decryptJson<{ secret: string }>(row.secretEncrypted);
  const ok = verifyTotp(secret, code);
  if (!ok) return { ok: false, reason: "bad-code" };

  await superDb.userTotp.update({
    where: { userId },
    data: {
      verifiedAt: new Date(),
      disabledAt: null,
      lastUsedAt: new Date(),
    },
  });

  await writeAuditOnPrimaryTenant({
    userId,
    eventType: "TOTP_ENROLLED",
    payload: { recoveryCodesRemaining: row.recoveryCodesHashed.length },
  });

  return { ok: true };
}

export async function disable({ userId, actorTenantId }: { userId: string; actorTenantId?: string }) {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row || row.disabledAt) return;
  await superDb.userTotp.update({
    where: { userId },
    data: { disabledAt: new Date(), verifiedAt: null, recoveryCodesHashed: [] },
  });
  await writeAuditOnPrimaryTenant({
    userId,
    eventType: "TOTP_DISABLED",
    payload: actorTenantId ? { actorTenantId } : {},
  });
}

/**
 * Verify a TOTP code (not a recovery code) against the User's current
 * secret. On success, stamps `Session.totpVerifiedAt` on the supplied
 * session id and the User's `lastUsedAt`. Audit:
 *   * `TOTP_VERIFIED` on success
 *   * `TOTP_VERIFICATION_FAILED` on failure (rate-limited by the route's
 *     existing rate-limit; we still emit one audit per failure so a
 *     governance review can see attack attempts)
 */
export async function verifyChallenge({
  userId,
  sessionId,
  code,
}: {
  userId: string;
  sessionId: string;
  code: string;
}): Promise<{ ok: true; matchedStep: number } | { ok: false; reason: "not-enrolled" | "bad-code" }> {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row || !row.verifiedAt || row.disabledAt) return { ok: false, reason: "not-enrolled" };
  const { secret } = decryptJson<{ secret: string }>(row.secretEncrypted);
  const match = verifyTotp(secret, code);
  if (!match) {
    await writeAuditOnPrimaryTenant({
      userId,
      eventType: "TOTP_VERIFICATION_FAILED",
      payload: { kind: "code" },
    });
    return { ok: false, reason: "bad-code" };
  }
  await stampSessionVerified(sessionId);
  await superDb.userTotp.update({ where: { userId }, data: { lastUsedAt: new Date() } });
  await writeAuditOnPrimaryTenant({
    userId,
    eventType: "TOTP_VERIFIED",
    payload: { matchedStep: match.matchedStep },
  });
  return { ok: true, matchedStep: match.matchedStep };
}

export async function consumeRecoveryCode({
  userId,
  sessionId,
  code,
}: {
  userId: string;
  sessionId: string;
  code: string;
}): Promise<
  | { ok: true; remaining: number }
  | { ok: false; reason: "not-enrolled" | "bad-code" }
> {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row || !row.verifiedAt || row.disabledAt) return { ok: false, reason: "not-enrolled" };
  const idx = findMatchingHashIndex(code, row.recoveryCodesHashed);
  if (idx === -1) {
    await writeAuditOnPrimaryTenant({
      userId,
      eventType: "TOTP_VERIFICATION_FAILED",
      payload: { kind: "recovery" },
    });
    return { ok: false, reason: "bad-code" };
  }
  const remaining = [...row.recoveryCodesHashed];
  remaining.splice(idx, 1);
  await superDb.userTotp.update({
    where: { userId },
    data: { recoveryCodesHashed: remaining, lastUsedAt: new Date() },
  });
  await stampSessionVerified(sessionId);
  await writeAuditOnPrimaryTenant({
    userId,
    eventType: "TOTP_RECOVERY_CODE_USED",
    payload: { remaining: remaining.length },
  });
  return { ok: true, remaining: remaining.length };
}

/**
 * Item 48 — regenerate recovery codes in place, without disabling 2FA.
 *
 * Requires a fresh TOTP code as proof of device possession; a leaked
 * cookie-only session must not be able to mint a new set of codes
 * (which would let an attacker bypass the device on a future login).
 * On success, replaces `recoveryCodesHashed` with the new hashed set
 * and returns the plaintext codes ONCE for the caller to display.
 * Stamps `lastUsedAt` like every other successful TOTP verification
 * and writes a `TOTP_RECOVERY_CODES_REGENERATED` audit event with
 * counts only (no codes, no hashes).
 *
 * Refuses on:
 *   - User not enrolled (returns `not-enrolled`)
 *   - Bad TOTP code (returns `bad-code` + writes TOTP_VERIFICATION_FAILED
 *     so brute-force attempts surface in the audit chain)
 */
export async function regenerateRecoveryCodes({
  userId,
  sessionId,
  code,
}: {
  userId: string;
  sessionId: string;
  code: string;
}): Promise<
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "not-enrolled" | "bad-code" }
> {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row || !row.verifiedAt || row.disabledAt) return { ok: false, reason: "not-enrolled" };
  const { secret } = decryptJson<{ secret: string }>(row.secretEncrypted);
  const match = verifyTotp(secret, code);
  if (!match) {
    await writeAuditOnPrimaryTenant({
      userId,
      eventType: "TOTP_VERIFICATION_FAILED",
      payload: { kind: "regen-recovery" },
    });
    return { ok: false, reason: "bad-code" };
  }
  const priorRemaining = row.recoveryCodesHashed.length;
  const codes = generateRecoveryCodes();
  const hashed = codes.map(hashRecoveryCode);
  await superDb.userTotp.update({
    where: { userId },
    data: { recoveryCodesHashed: hashed, lastUsedAt: new Date() },
  });
  // Bump the session's TOTP-verified stamp — the user just proved
  // device possession with a fresh code, which is also what step-up
  // verification looks for elsewhere.
  await stampSessionVerified(sessionId);
  await writeAuditOnPrimaryTenant({
    userId,
    eventType: "TOTP_RECOVERY_CODES_REGENERATED",
    payload: { count: codes.length, priorRemaining },
  });
  return { ok: true, recoveryCodes: codes };
}

export async function getEnrollmentStatus(userId: string): Promise<{
  enrolled: boolean;
  recoveryCodesRemaining: number;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
}> {
  const row = await superDb.userTotp.findUnique({ where: { userId } });
  if (!row || !row.verifiedAt || row.disabledAt) {
    return { enrolled: false, recoveryCodesRemaining: 0, verifiedAt: null, lastUsedAt: null };
  }
  return {
    enrolled: true,
    recoveryCodesRemaining: row.recoveryCodesHashed.length,
    verifiedAt: row.verifiedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Persist `Session.totpVerifiedAt` for the given NextAuth session id.
 * Silently no-ops if the session row is missing (callers will have
 * arrived here only via a valid session, but defence-in-depth).
 */
async function stampSessionVerified(sessionId: string): Promise<void> {
  try {
    await superDb.session.update({
      where: { id: sessionId },
      data: { totpVerifiedAt: new Date() },
    });
  } catch {
    // Session may have expired between auth() and this write. Caller will
    // surface a generic auth failure on the next request.
  }
}

/**
 * Resolve the primary tenant for per-User audit events. Picks the User's
 * oldest ACTIVE membership; if there is none, returns null and the audit
 * is skipped (the event still happens, but it cannot be anchored to a
 * chain — only relevant for users with no memberships, e.g. mid-anonymise).
 */
async function primaryActiveTenantId(userId: string): Promise<string | null> {
  const m = await superDb.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    select: { tenantId: true, id: true },
  });
  return m?.tenantId ?? null;
}

async function writeAuditOnPrimaryTenant({
  userId,
  eventType,
  payload,
}: {
  userId: string;
  eventType:
    | "TOTP_ENROLLED"
    | "TOTP_DISABLED"
    | "TOTP_VERIFIED"
    | "TOTP_VERIFICATION_FAILED"
    | "TOTP_RECOVERY_CODE_USED"
    | "TOTP_RECOVERY_CODES_REGENERATED";
  payload: Record<string, unknown>;
}): Promise<void> {
  const tenantId = await primaryActiveTenantId(userId);
  if (!tenantId) return;
  await writeAuditEvent({
    tenantId,
    eventType,
    actorMembershipId: null,
    subjectType: "UserTotp",
    subjectId: userId,
    payload: payload as Parameters<typeof writeAuditEvent>[0]["payload"],
  });
}

export const _internalForTesting = {
  RECOVERY_CODE_COUNT,
  primaryActiveTenantId,
};
