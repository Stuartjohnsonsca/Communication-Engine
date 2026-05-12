/**
 * Post-PRD hardening item 48 — TOTP recovery code regeneration without
 * disabling 2FA.
 *
 * Coverage:
 *   - Happy path: a valid current TOTP code regenerates a fresh set;
 *     the new codes are returned exactly once and the previous codes
 *     stop verifying.
 *   - Bad TOTP code: returns `bad-code` and writes a
 *     TOTP_VERIFICATION_FAILED audit so brute-force attempts surface.
 *   - Not enrolled: returns `not-enrolled` for a user without a
 *     verified TOTP row.
 *   - Audit: a `TOTP_RECOVERY_CODES_REGENERATED` event lands on the
 *     primary tenant chain with `{ count, priorRemaining }` and NO
 *     plaintext / hashes in the payload.
 *   - The hashed code list is replaced atomically: count after regen
 *     equals RECOVERY_CODE_COUNT regardless of how many remained
 *     beforehand.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  initiateEnrollment,
  verifyEnrollment,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
  generateTotp,
  RECOVERY_CODE_COUNT,
} from "@/lib/auth/totp";
import { encryptJson, decryptJson } from "@/lib/channels/crypto";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

async function enrolledUser() {
  const tenant = await createTestTenant();
  const { user, membership } = await createTestUserAndMembership(tenant.id, {
    email: uniqueEmail("totp-regen"),
    role: "FIRM_ADMIN",
  });
  const init = await initiateEnrollment({
    userId: user.id,
    accountEmail: user.email,
  });
  const code = generateTotp(init.secretBase32);
  const v = await verifyEnrollment({ userId: user.id, code });
  expect(v.ok).toBe(true);

  // We need a session for the regenerate flow.
  const session = await superDb.session.create({
    data: {
      userId: user.id,
      sessionToken: randomUUID(),
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return {
    tenant,
    membership,
    user,
    sessionId: session.id,
    secret: init.secretBase32,
    originalRecoveryCodes: init.recoveryCodes,
  };
}

describe("TOTP — regenerate recovery codes", () => {
  it("happy path: returns a fresh set, previous codes stop verifying", async () => {
    const setup = await enrolledUser();
    const totp = generateTotp(setup.secret);

    const res = await regenerateRecoveryCodes({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: totp,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recoveryCodes.length).toBe(RECOVERY_CODE_COUNT);
    // None of the new codes overlap with the old set.
    const oldSet = new Set(setup.originalRecoveryCodes);
    for (const c of res.recoveryCodes) {
      expect(oldSet.has(c)).toBe(false);
    }

    // Try consuming one of the OLD codes — must fail (set was replaced).
    const consumeOld = await consumeRecoveryCode({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: setup.originalRecoveryCodes[0],
    });
    expect(consumeOld.ok).toBe(false);

    // Consuming a NEW code succeeds and decrements.
    const consumeNew = await consumeRecoveryCode({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: res.recoveryCodes[0],
    });
    expect(consumeNew.ok).toBe(true);
    if (consumeNew.ok) {
      expect(consumeNew.remaining).toBe(RECOVERY_CODE_COUNT - 1);
    }
  });

  it("rejects a wrong TOTP code and writes a TOTP_VERIFICATION_FAILED audit", async () => {
    const setup = await enrolledUser();
    const auditBefore = await superDb.auditEvent.count({
      where: {
        tenantId: setup.tenant.id,
        eventType: "TOTP_VERIFICATION_FAILED",
        subjectId: setup.user.id,
      },
    });

    const res = await regenerateRecoveryCodes({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: "000000",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-code");

    const auditAfter = await superDb.auditEvent.count({
      where: {
        tenantId: setup.tenant.id,
        eventType: "TOTP_VERIFICATION_FAILED",
        subjectId: setup.user.id,
      },
    });
    expect(auditAfter).toBe(auditBefore + 1);
  });

  it("refuses when the user is not enrolled", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("totp-not-enrolled"),
    });
    const session = await superDb.session.create({
      data: {
        userId: user.id,
        sessionToken: randomUUID(),
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const res = await regenerateRecoveryCodes({
      userId: user.id,
      sessionId: session.id,
      code: "123456",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-enrolled");
  });

  it("audit event records counts only (no plaintext / hashes)", async () => {
    const setup = await enrolledUser();
    // Consume two old codes so the priorRemaining is meaningful.
    await consumeRecoveryCode({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: setup.originalRecoveryCodes[0],
    });
    await consumeRecoveryCode({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: setup.originalRecoveryCodes[1],
    });

    const totp = generateTotp(setup.secret);
    const res = await regenerateRecoveryCodes({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: totp,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: setup.tenant.id,
        eventType: "TOTP_RECOVERY_CODES_REGENERATED",
        subjectId: setup.user.id,
      },
      orderBy: { seq: "desc" },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as { count: number; priorRemaining: number };
    expect(payload.count).toBe(RECOVERY_CODE_COUNT);
    expect(payload.priorRemaining).toBe(RECOVERY_CODE_COUNT - 2);

    // No plaintext / hash material in the payload.
    const payloadStr = JSON.stringify(audit!.payload);
    for (const c of res.recoveryCodes) {
      expect(payloadStr).not.toContain(c);
      const normalised = c.replace(/-/g, "");
      expect(payloadStr).not.toContain(normalised);
    }
  });

  it("replaces atomically: count after regen is RECOVERY_CODE_COUNT regardless of prior remaining", async () => {
    const setup = await enrolledUser();
    // Burn through 5 codes.
    for (let i = 0; i < 5; i += 1) {
      const r = await consumeRecoveryCode({
        userId: setup.user.id,
        sessionId: setup.sessionId,
        code: setup.originalRecoveryCodes[i],
      });
      expect(r.ok).toBe(true);
    }

    const totp = generateTotp(setup.secret);
    const res = await regenerateRecoveryCodes({
      userId: setup.user.id,
      sessionId: setup.sessionId,
      code: totp,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await superDb.userTotp.findUnique({ where: { userId: setup.user.id } });
    expect(row!.recoveryCodesHashed.length).toBe(RECOVERY_CODE_COUNT);
  });
});

// Silence "encryption/decryption helper untouched in this file" lint by
// keeping a no-op reference to the helpers we expect to remain stable.
void encryptJson;
void decryptJson;
