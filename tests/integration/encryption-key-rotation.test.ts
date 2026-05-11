/**
 * Encryption-key rotation (post-PRD hardening item 27).
 *
 * Coverage:
 *   - keys.ts registry assembly (single-key fallback, JSON multi-key, active
 *     version selection, invalid inputs rejected).
 *   - Versioned encrypt/decrypt round-trip with v1 and v2.
 *   - Legacy unversioned blob decrypts against v1.
 *   - decrypt against a missing version throws a typed error.
 *   - Rotation script: rotates non-active blobs, leaves active-version
 *     blobs alone, idempotent re-run is a no-op, audit event written
 *     once per rotation pass with summary counts.
 *   - ApiKey: new key issued under active version; verification looks up
 *     keyVersion so a v1-keyed key still verifies after the active version
 *     advances to v2.
 */
import { randomBytes, createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildRegistry,
  encryptJsonWith,
  decryptJsonWith,
  classifyBlob,
  hasVersionPrefix,
  EncryptionKeyError,
  _resetRegistryCache,
} from "@/lib/crypto/keys";
import { createApiKey } from "@/lib/auth/api-keys/store";
import { authenticateApiKey } from "@/lib/auth/api-keys/store";
import { computeHash, generateApiKey } from "@/lib/auth/api-keys/secret";
import { superDb } from "@/lib/db";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";
import { runRotation } from "../../scripts/rotate-encryption-keys";

function genKey(): string {
  return randomBytes(32).toString("base64");
}

function ensureAcumonOperator(): Promise<{ id: string }> {
  return (async () => {
    const existing = await superDb.tenant.findUnique({ where: { slug: "acumon" } });
    if (existing) return { id: existing.id };
    const created = await superDb.tenant.create({
      data: { slug: "acumon", name: "Acumon (operator) — test" },
    });
    return { id: created.id };
  })();
}

describe("crypto/keys registry", () => {
  it("falls back to single ENCRYPTION_KEY as v1 with active=v1", () => {
    const k = genKey();
    const reg = buildRegistry({ keysJson: null, singleKey: k, active: null });
    expect(reg.keys.has("v1")).toBe(true);
    expect(reg.active).toBe("v1");
  });

  it("rejects an ENCRYPTION_KEY of the wrong length", () => {
    const tooShort = Buffer.alloc(16, 1).toString("base64");
    expect(() => buildRegistry({ keysJson: null, singleKey: tooShort, active: null })).toThrow(
      EncryptionKeyError,
    );
  });

  it("parses ENCRYPTION_KEYS JSON and picks the highest version as active by default", () => {
    const k1 = genKey();
    const k2 = genKey();
    const reg = buildRegistry({
      keysJson: JSON.stringify({ v1: k1, v2: k2 }),
      singleKey: null,
      active: null,
    });
    expect(reg.keys.size).toBe(2);
    expect(reg.active).toBe("v2");
  });

  it("respects explicit ENCRYPTION_KEY_ACTIVE_VERSION", () => {
    const reg = buildRegistry({
      keysJson: JSON.stringify({ v1: genKey(), v2: genKey() }),
      singleKey: null,
      active: "v1",
    });
    expect(reg.active).toBe("v1");
  });

  it("rejects an active version not in the registry", () => {
    expect(() =>
      buildRegistry({
        keysJson: JSON.stringify({ v1: genKey() }),
        singleKey: null,
        active: "v9",
      }),
    ).toThrow(/active-not-in-registry|does not contain/);
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(() =>
      buildRegistry({ keysJson: "{not json}", singleKey: null, active: null }),
    ).toThrow(EncryptionKeyError);
    expect(() =>
      buildRegistry({ keysJson: '["v1","abc"]', singleKey: null, active: null }),
    ).toThrow(EncryptionKeyError);
  });

  it("rejects an empty configuration", () => {
    expect(() =>
      buildRegistry({ keysJson: null, singleKey: null, active: null }),
    ).toThrow(/no encryption key configured/i);
  });
});

describe("crypto/keys encrypt/decrypt", () => {
  it("round-trips under v1", () => {
    const reg = buildRegistry({ keysJson: null, singleKey: genKey(), active: null });
    const blob = encryptJsonWith(reg, { hello: "world", n: 42 });
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptJsonWith(reg, blob)).toEqual({ hello: "world", n: 42 });
  });

  it("round-trips under v2 while leaving v1 readable", () => {
    const k1 = genKey();
    const k2 = genKey();
    const reg = buildRegistry({
      keysJson: JSON.stringify({ v1: k1, v2: k2 }),
      singleKey: null,
      active: "v2",
    });
    const v2Blob = encryptJsonWith(reg, { msg: "v2" });
    expect(v2Blob.startsWith("v2:")).toBe(true);
    expect(decryptJsonWith(reg, v2Blob)).toEqual({ msg: "v2" });

    const singleV1 = buildRegistry({ keysJson: null, singleKey: k1, active: null });
    const v1Blob = encryptJsonWith(singleV1, { msg: "v1" });
    expect(v1Blob.startsWith("v1:")).toBe(true);
    expect(decryptJsonWith(reg, v1Blob)).toEqual({ msg: "v1" });
  });

  it("treats a legacy unversioned blob as v1", () => {
    const k1 = genKey();
    const v1Only = buildRegistry({ keysJson: null, singleKey: k1, active: null });
    const blob = encryptJsonWith(v1Only, "x");
    const stripped = blob.replace(/^v1:/, "");
    expect(hasVersionPrefix(stripped)).toBe(false);
    expect(classifyBlob(stripped)).toEqual({ version: "v1", legacy: true });
    expect(decryptJsonWith(v1Only, stripped)).toBe("x");
  });

  it("throws when a blob's version isn't in the registry", () => {
    const k2 = genKey();
    const v2Only = buildRegistry({
      keysJson: JSON.stringify({ v2: k2 }),
      singleKey: null,
      active: null,
    });
    const stranger = `v1:${Buffer.from(randomBytes(64)).toString("base64")}`;
    expect(() => decryptJsonWith(v2Only, stranger)).toThrow(/unknown-version|not present/i);
  });
});

describe("api-keys: keyVersion roundtrip", () => {
  let tenantId: string;
  let actorMembershipId: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = {
      ENCRYPTION_KEYS: process.env.ENCRYPTION_KEYS,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      ENCRYPTION_KEY_ACTIVE_VERSION: process.env.ENCRYPTION_KEY_ACTIVE_VERSION,
    };

    const t = await createTestTenant();
    tenantId = t.id;
    const adminFixture = await createTestUserAndMembership(tenantId, { role: "FIRM_ADMIN" });
    actorMembershipId = adminFixture.membership.id;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetRegistryCache();
  });

  it("issues a v1 key when only the legacy ENCRYPTION_KEY is set", async () => {
    // Test setup already provides ENCRYPTION_KEY-equivalent via NEXTAUTH_SECRET
    // for HMAC. Force v1-only registry on top.
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY_ACTIVE_VERSION;
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = genKey();
    }
    _resetRegistryCache();

    const { apiKey, plaintext } = await createApiKey({
      tenantId,
      actorMembershipId,
      actorRole: "FIRM_ADMIN",
      name: "v1 key",
      scopes: ["audit:read"],
    });
    expect(apiKey.keyVersion).toBe("v1");

    // Extract prefix and secret from the plaintext (format ack_<prefix>_<secret>).
    const [, prefix, secret] = plaintext.split("_");
    const authed = await authenticateApiKey({ prefix: prefix!, secret: secret! });
    expect(authed).not.toBeNull();
    expect(authed!.apiKey.id).toBe(apiKey.id);
  });

  it("v1 keys still verify after the active version advances to v2", async () => {
    // Phase 1: issue a v1 key under the legacy posture.
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY_ACTIVE_VERSION;
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = genKey();
    }
    _resetRegistryCache();

    const phase1 = await createApiKey({
      tenantId,
      actorMembershipId,
      actorRole: "FIRM_ADMIN",
      name: "phase 1",
      scopes: ["audit:read"],
    });
    expect(phase1.apiKey.keyVersion).toBe("v1");
    const [, p1Prefix, p1Secret] = phase1.plaintext.split("_");

    // Phase 2: rotate to a multi-key registry with active=v2. The v1
    // entry in the JSON registry MUST encode the same bytes as the prior
    // ENCRYPTION_KEY so that legacy AES blobs continue to decrypt. The
    // legacy ApiKey HMAC posture (utf8 of env-string) is preserved by the
    // module — only v2+ HMACs use the 32-byte AES key from the registry.
    const v2 = genKey();
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      v1: process.env.ENCRYPTION_KEY!,
      v2,
    });
    process.env.ENCRYPTION_KEY_ACTIVE_VERSION = "v2";
    _resetRegistryCache();

    // Phase 1 key still authenticates.
    const stillOk = await authenticateApiKey({ prefix: p1Prefix!, secret: p1Secret! });
    expect(stillOk).not.toBeNull();
    expect(stillOk!.apiKey.id).toBe(phase1.apiKey.id);

    // Phase 2 key issued under v2.
    const phase2 = await createApiKey({
      tenantId,
      actorMembershipId,
      actorRole: "FIRM_ADMIN",
      name: "phase 2",
      scopes: ["audit:read"],
    });
    expect(phase2.apiKey.keyVersion).toBe("v2");
    const [, p2Prefix, p2Secret] = phase2.plaintext.split("_");
    const p2Authed = await authenticateApiKey({ prefix: p2Prefix!, secret: p2Secret! });
    expect(p2Authed).not.toBeNull();

    // computeHash signature: explicit version still produces the stored hash.
    const p1Row = await superDb.apiKey.findUnique({ where: { id: phase1.apiKey.id } });
    const p2Row = await superDb.apiKey.findUnique({ where: { id: phase2.apiKey.id } });
    expect(computeHash(p1Prefix!, p1Secret!, "v1")).toBe(p1Row!.hash);
    expect(computeHash(p2Prefix!, p2Secret!, "v2")).toBe(p2Row!.hash);
  });
});

describe("rotation script", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      ENCRYPTION_KEYS: process.env.ENCRYPTION_KEYS,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      ENCRYPTION_KEY_ACTIVE_VERSION: process.env.ENCRYPTION_KEY_ACTIVE_VERSION,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetRegistryCache();
  });

  it("rotates a UserTotp blob from v1 to v2, idempotent on re-run", async () => {
    // Phase 1: encrypt under v1 only.
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = genKey();
    }
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY_ACTIVE_VERSION;
    _resetRegistryCache();
    const v1Registry = buildRegistry({
      keysJson: null,
      singleKey: process.env.ENCRYPTION_KEY!,
      active: null,
    });

    // Make a unique User scoped to a fresh tenant so this test doesn't
    // trip the UserTotp.userId UNIQUE index.
    await createTestTenant();
    const user = await superDb.user.create({
      data: { email: `rot-${Date.now()}-${Math.random()}@example.com` },
    });
    const totpBlob = encryptJsonWith(v1Registry, { secret: "test-totp-secret" });
    expect(totpBlob.startsWith("v1:")).toBe(true);

    await superDb.userTotp.create({
      data: {
        userId: user.id,
        secretEncrypted: totpBlob,
        recoveryCodesHashed: [],
      },
    });

    // Make sure there's an acumon operator tenant so the rotation audit
    // event can land on it without a warning.
    await ensureAcumonOperator();

    // Phase 2: configure a v2-active registry containing v1 + v2.
    const v2Key = genKey();
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      v1: process.env.ENCRYPTION_KEY!,
      v2: v2Key,
    });
    process.env.ENCRYPTION_KEY_ACTIVE_VERSION = "v2";
    _resetRegistryCache();

    const r1 = await runRotation();
    expect(r1.activeVersion).toBe("v2");
    expect(r1.userTotp.rotated).toBeGreaterThanOrEqual(1);
    expect(r1.userTotp.failed).toBe(0);

    const after = await superDb.userTotp.findUnique({ where: { userId: user.id } });
    expect(after).not.toBeNull();
    expect(after!.secretEncrypted.startsWith("v2:")).toBe(true);
    // And the plaintext round-trips under v2.
    const v2Registry = buildRegistry({
      keysJson: process.env.ENCRYPTION_KEYS!,
      singleKey: null,
      active: "v2",
    });
    expect(decryptJsonWith<{ secret: string }>(v2Registry, after!.secretEncrypted)).toEqual({
      secret: "test-totp-secret",
    });

    // Idempotent: re-running with the same active version touches nothing.
    const r2 = await runRotation();
    expect(r2.userTotp.rotated).toBe(0);
    // Skipped = every v2-prefixed row scanned. Failed = 0.
    expect(r2.userTotp.failed).toBe(0);
    expect(r2.userTotp.scanned).toBeGreaterThanOrEqual(1);

    // Suppress unused warning on the imports
    void generateApiKey;
    void createHmac;
  });

  it("emits an ENCRYPTION_KEYS_ROTATED audit when work was done", async () => {
    // Run only if at least one blob got rotated in the previous test —
    // we count audit events created with eventType ENCRYPTION_KEYS_ROTATED.
    const events = await superDb.auditEvent.findMany({
      where: { eventType: "ENCRYPTION_KEYS_ROTATED" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.activeVersion).toBeDefined();
  });
});
