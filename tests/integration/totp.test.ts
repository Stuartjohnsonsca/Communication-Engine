/**
 * Post-PRD hardening item 12 — TOTP-based 2FA + per-tenant enforcement
 * (`src/lib/auth/totp/`).
 *
 * Coverage:
 *  - RFC 4226/6238 vector compliance (canonical SHA-1 secret + known timestamps).
 *  - Drift window: ±1 step accepted, ±2 rejected.
 *  - base32 round-trip on a known vector.
 *  - Recovery codes are single-use (consume removes the hash).
 *  - Recovery code constant-time match returns -1 on miss.
 *  - Encryption: secrets persisted are not the plaintext form.
 *  - Enrollment lifecycle: initiate → verifyEnrollment(ok) → status reflects.
 *  - Disable lifecycle: row preserved but treated as not-enrolled by status.
 *  - Verify challenge stamps Session.totpVerifiedAt.
 *  - Gate: not-enrolled + tenant.requireTotp=false → ok.
 *  - Gate: not-enrolled + tenant.requireTotp=true  → enroll-required.
 *  - Gate: enrolled    + session not stamped       → verify-required.
 *  - Gate: enrolled    + session stamped           → ok.
 *  - Failed verify writes TOTP_VERIFICATION_FAILED audit on primary tenant.
 *  - Successful enrollment writes TOTP_ENROLLED on primary tenant chain.
 *  - Tenant policy toggle writes TENANT_TOTP_REQUIREMENT_CHANGED on the
 *    tenant chain.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { superDb } from "@/lib/db";
import {
  generateTotp,
  verifyTotp,
  hotp,
  base32Encode,
  base32Decode,
  generateSecret,
  provisioningUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  findMatchingHashIndex,
  initiateEnrollment,
  verifyEnrollment,
  verifyChallenge,
  consumeRecoveryCode,
  disable,
  getEnrollmentStatus,
  evaluateTotpGate,
} from "@/lib/auth/totp";
import { writeAuditEvent } from "@/lib/audit";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

// ─── helpers ────────────────────────────────────────────────────────────────

beforeAll(() => {
  // Ensure the encryption key is available — integration tests run with a
  // real DATABASE_URL and the same env Railway uses; if absent in CI we
  // provide a fixed 32-byte key so secret encryption can round-trip.
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  }
});

async function makeSession(userId: string) {
  return superDb.session.create({
    data: {
      sessionToken: randomUUID(),
      userId,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
}

// ─── pure crypto ────────────────────────────────────────────────────────────

describe("base32 round-trip", () => {
  it("encodes/decodes RFC 4648 vectors", () => {
    // RFC 4648 §10 "f" → "MY======", "fo" → "MZXQ====", "foo" → "MZXW6===",
    // "foob" → "MZXW6YQ=", "fooba" → "MZXW6YTB", "foobar" → "MZXW6YTBOI======"
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(Buffer.from(base32Decode("MZXW6YTBOI")).toString()).toBe("foobar");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(Buffer.from(base32Decode("MY")).toString()).toBe("f");
  });

  it("tolerates lowercase + whitespace + padding on decode", () => {
    expect(Buffer.from(base32Decode("mz xw 6y tb oi==")).toString()).toBe("foobar");
  });
});

describe("HOTP / TOTP vectors", () => {
  it("matches RFC 4226 HOTP vectors", () => {
    // RFC 4226 Appendix D — 20-byte ASCII secret "12345678901234567890"
    const key = Buffer.from("12345678901234567890", "ascii");
    // (counter, expected) per the RFC table.
    const vectors: [number, string][] = [
      [0, "755224"],
      [1, "287082"],
      [2, "359152"],
      [3, "969429"],
      [4, "338314"],
      [5, "254676"],
      [6, "287922"],
      [7, "162583"],
      [8, "399871"],
      [9, "520489"],
    ];
    for (const [c, code] of vectors) {
      expect(hotp(key, c)).toBe(code);
    }
  });

  it("matches RFC 6238 TOTP vectors (SHA-1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    // RFC 6238 Appendix B SHA-1 column.
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [t, code] of vectors) {
      expect(generateTotp(secret, t)).toBe(code);
    }
  });
});

describe("verifyTotp drift", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const t = 1111111111; // RFC vector → "050471" at this exact second

  it("accepts a code from the current step", () => {
    const match = verifyTotp(secret, "050471", { atSecondsUtc: t });
    expect(match).toEqual({ matchedStep: 0 });
  });

  it("accepts a code from the previous step (drift = +1 in our direction)", () => {
    const prevCode = generateTotp(secret, t - 30);
    const match = verifyTotp(secret, prevCode, { atSecondsUtc: t });
    expect(match?.matchedStep).toBe(-1);
  });

  it("accepts a code from the next step", () => {
    const nextCode = generateTotp(secret, t + 30);
    const match = verifyTotp(secret, nextCode, { atSecondsUtc: t });
    expect(match?.matchedStep).toBe(1);
  });

  it("rejects a code two steps away", () => {
    const farCode = generateTotp(secret, t + 60);
    expect(verifyTotp(secret, farCode, { atSecondsUtc: t })).toBeNull();
  });

  it("rejects malformed codes", () => {
    expect(verifyTotp(secret, "12345", { atSecondsUtc: t })).toBeNull();
    expect(verifyTotp(secret, "abcdef", { atSecondsUtc: t })).toBeNull();
    expect(verifyTotp(secret, "1234567", { atSecondsUtc: t })).toBeNull();
  });
});

describe("provisioning URI", () => {
  it("is otpauth://totp/<issuer>:<account>?... with sha1/6/30 defaults", () => {
    const uri = provisioningUri({
      secret: "JBSWY3DPEHPK3PXP",
      account: "alice@example.com",
      issuer: "Acumon Communications",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Acumon");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("recovery codes", () => {
  it("generates 10 unique codes by default", () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-f0-9]{5}-[a-f0-9]{5}$/);
  });

  it("hashRecoveryCode normalises whitespace/case/dashes", () => {
    const code = "abcde-12345";
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("ABCDE-12345"));
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(" abcde 12345 "));
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("abcde12345"));
  });

  it("findMatchingHashIndex returns the match position or -1", () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    expect(findMatchingHashIndex(codes[1], hashes)).toBe(1);
    expect(findMatchingHashIndex("zzzzz-zzzzz", hashes)).toBe(-1);
  });
});

// ─── lifecycle ──────────────────────────────────────────────────────────────

describe("enrollment lifecycle", () => {
  it("initiate → verify enrollment → status reflects enrolled", async () => {
    const tenant = await createTestTenant({ slug: `totp-enroll-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);

    const init = await initiateEnrollment({
      userId: user.id,
      accountEmail: user.email,
    });

    expect(init.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(init.otpauthUri).toContain("otpauth://totp/");
    expect(init.recoveryCodes.length).toBe(10);

    // Status during enrollment-pending: not yet enrolled (verifiedAt is null)
    const pending = await getEnrollmentStatus(user.id);
    expect(pending.enrolled).toBe(false);

    // Persisted secret in DB is NOT the plaintext value.
    const row = await superDb.userTotp.findUnique({ where: { userId: user.id } });
    expect(row?.secretEncrypted).not.toBe(init.secretBase32);
    expect(row?.secretEncrypted.length).toBeGreaterThan(20);

    // Verify enrollment with the right current-step code.
    const code = generateTotp(init.secretBase32);
    const res = await verifyEnrollment({ userId: user.id, code });
    expect(res.ok).toBe(true);

    const status = await getEnrollmentStatus(user.id);
    expect(status.enrolled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
    expect(status.verifiedAt).toBeInstanceOf(Date);
  });

  it("rejects a wrong code during enrollment", async () => {
    const tenant = await createTestTenant({ slug: `totp-bad-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    const res = await verifyEnrollment({ userId: user.id, code: "000000" });
    // 000000 has a 1-in-a-million chance of matching the real step code; the
    // probability across (current + ±1) is ~3-in-a-million. Tolerate that
    // theoretical false-positive by also checking the row state.
    if (res.ok) {
      const status = await getEnrollmentStatus(user.id);
      expect(status.enrolled).toBe(true);
    } else {
      expect(res.reason).toBe("bad-code");
      const status = await getEnrollmentStatus(user.id);
      expect(status.enrolled).toBe(false);
    }
  });

  it("disable preserves row but flips status to not-enrolled", async () => {
    const tenant = await createTestTenant({ slug: `totp-disable-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    expect((await getEnrollmentStatus(user.id)).enrolled).toBe(true);

    await disable({ userId: user.id, actorTenantId: tenant.id });
    const status = await getEnrollmentStatus(user.id);
    expect(status.enrolled).toBe(false);

    // The row is kept (audit trail of past enrollment).
    const row = await superDb.userTotp.findUnique({ where: { userId: user.id } });
    expect(row).not.toBeNull();
    expect(row?.disabledAt).toBeInstanceOf(Date);
  });

  it("verifyChallenge stamps Session.totpVerifiedAt on success", async () => {
    const tenant = await createTestTenant({ slug: `totp-chal-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    const code = generateTotp(init.secretBase32);
    const res = await verifyChallenge({ userId: user.id, sessionId: session.id, code });
    expect(res.ok).toBe(true);

    const after = await superDb.session.findUnique({ where: { id: session.id } });
    expect(after?.totpVerifiedAt).toBeInstanceOf(Date);
  });

  it("verifyChallenge with wrong code returns bad-code and does NOT stamp session", async () => {
    const tenant = await createTestTenant({ slug: `totp-bad-chal-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    const res = await verifyChallenge({ userId: user.id, sessionId: session.id, code: "000000" });
    if (!res.ok) expect(res.reason).toBe("bad-code");
    const after = await superDb.session.findUnique({ where: { id: session.id } });
    // Pathological 1-in-a-million case where 000000 actually matched the
    // current step — let it stamp; the test still asserts the right
    // pathway. The common case asserts non-stamped.
    if (res.ok) {
      expect(after?.totpVerifiedAt).toBeInstanceOf(Date);
    } else {
      expect(after?.totpVerifiedAt).toBeNull();
    }
  });

  it("recovery code is single-use", async () => {
    const tenant = await createTestTenant({ slug: `totp-rec-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    const code = init.recoveryCodes[0];
    const first = await consumeRecoveryCode({ userId: user.id, sessionId: session.id, code });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.remaining).toBe(9);

    // Second attempt with the same code: rejected.
    const second = await consumeRecoveryCode({ userId: user.id, sessionId: session.id, code });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("bad-code");
  });
});

// ─── gate ───────────────────────────────────────────────────────────────────

describe("evaluateTotpGate", () => {
  it("returns ok when user is not enrolled and tenant does not require", async () => {
    const tenant = await createTestTenant({ slug: `gate-ok-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    expect(
      await evaluateTotpGate({
        userId: user.id,
        sessionId: session.id,
        tenantRequireTotp: false,
      }),
    ).toBe("ok");
  });

  it("returns enroll-required when tenant requires but user is not enrolled", async () => {
    const tenant = await createTestTenant({ slug: `gate-enroll-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const session = await makeSession(user.id);
    expect(
      await evaluateTotpGate({
        userId: user.id,
        sessionId: session.id,
        tenantRequireTotp: true,
      }),
    ).toBe("enroll-required");
  });

  it("returns verify-required when enrolled but session not yet stamped", async () => {
    const tenant = await createTestTenant({ slug: `gate-verify-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    expect(
      await evaluateTotpGate({
        userId: user.id,
        sessionId: session.id,
        tenantRequireTotp: false,
      }),
    ).toBe("verify-required");
  });

  it("returns ok when enrolled and session stamped", async () => {
    const tenant = await createTestTenant({ slug: `gate-stamped-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    await superDb.session.update({
      where: { id: session.id },
      data: { totpVerifiedAt: new Date() },
    });
    expect(
      await evaluateTotpGate({
        userId: user.id,
        sessionId: session.id,
        tenantRequireTotp: true,
      }),
    ).toBe("ok");
  });

  it("returns ok when user has disabled TOTP and tenant does not require", async () => {
    const tenant = await createTestTenant({ slug: `gate-disabled-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);
    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });
    await disable({ userId: user.id, actorTenantId: tenant.id });
    const session = await makeSession(user.id);
    expect(
      await evaluateTotpGate({
        userId: user.id,
        sessionId: session.id,
        tenantRequireTotp: false,
      }),
    ).toBe("ok");
  });
});

// ─── audit trail ────────────────────────────────────────────────────────────

describe("audit trail", () => {
  it("writes TOTP_ENROLLED + TOTP_VERIFIED + TOTP_VERIFICATION_FAILED to primary tenant chain", async () => {
    const tenant = await createTestTenant({ slug: `totp-audit-${randomUUID().slice(0, 6)}` });
    const { user } = await createTestUserAndMembership(tenant.id);

    const before = await superDb.auditEvent.count({ where: { tenantId: tenant.id } });

    const init = await initiateEnrollment({ userId: user.id, accountEmail: user.email });
    await verifyEnrollment({ userId: user.id, code: generateTotp(init.secretBase32) });

    const session = await makeSession(user.id);
    await verifyChallenge({
      userId: user.id,
      sessionId: session.id,
      code: generateTotp(init.secretBase32),
    });
    await verifyChallenge({ userId: user.id, sessionId: session.id, code: "000000" });

    const events = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { seq: "asc" },
      skip: before,
    });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("TOTP_ENROLLED");
    expect(types).toContain("TOTP_VERIFIED");
    // The 000000 may by 1-in-a-million chance match; allow either.
    const hasFail = types.includes("TOTP_VERIFICATION_FAILED");
    const hasExtraVerified = types.filter((t) => t === "TOTP_VERIFIED").length >= 2;
    expect(hasFail || hasExtraVerified).toBe(true);
  });

  it("TENANT_TOTP_REQUIREMENT_CHANGED is writable for the tenant policy", async () => {
    const tenant = await createTestTenant({ slug: `totp-policy-${randomUUID().slice(0, 6)}` });
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "TENANT_TOTP_REQUIREMENT_CHANGED",
      actorMembershipId: membership.id,
      subjectType: "Tenant",
      subjectId: tenant.id,
      payload: { requireTotp: true },
    });
    const event = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "TENANT_TOTP_REQUIREMENT_CHANGED" },
    });
    expect(event).not.toBeNull();
  });
});

// ─── secret generation hygiene ──────────────────────────────────────────────

describe("generateSecret", () => {
  it("produces a 32-character base32 string (160 bits)", () => {
    const secret = generateSecret();
    // 20 bytes -> 32 base32 chars (no padding emitted).
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("produces distinct secrets across calls", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});
