/**
 * Post-PRD hardening item 16 — programmatic API keys.
 *
 * Coverage:
 *  - secret module: generate produces the canonical shape; parse round-trips;
 *    parse rejects malformed inputs; hashesMatch is constant-time-shaped.
 *  - scopes module: assertAssignable rejects scopes whose underlying RBAC
 *    permissions the issuing role doesn't hold; wildcard cannot be combined
 *    with named scopes; scopeAllows respects role downgrades.
 *  - store: createApiKey persists the hash (not the secret), writes
 *    API_KEY_CREATED audit, returns the plaintext exactly once.
 *  - authenticateApiKey: hash mismatch returns null; revoked returns null;
 *    expired returns null; inactive creator-Membership returns null;
 *    lastUsedAt is bumped on success and throttled (no second write within
 *    60s).
 *  - revokeApiKey: writes API_KEY_REVOKED audit on user/admin path,
 *    API_KEY_AUTO_REVOKED on system path; idempotent on already-revoked.
 *  - sweepInactiveOrExpiredApiKeys: revokes keys with inactive creators or
 *    past-expiry, idempotent second run.
 *  - cross-tenant isolation: a key issued in tenant A cannot be returned by
 *    listApiKeysForTenant(B).
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  generateApiKey,
  parseApiKey,
  computeHash,
  hashesMatch,
  PREFIX_LEN,
  SECRET_LEN,
  BRAND,
  assertAssignable,
  scopeAllows,
  ScopeError,
  createApiKey,
  revokeApiKey,
  listApiKeysForTenant,
  authenticateApiKey,
  sweepInactiveOrExpiredApiKeys,
  ApiKeyValidationError,
} from "@/lib/auth/api-keys";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

describe("api keys :: secret", () => {
  it("generateApiKey emits the canonical shape", () => {
    const k = generateApiKey();
    expect(k.plaintext).toBe(`${BRAND}_${k.prefix}_${k.secret}`);
    expect(k.prefix).toHaveLength(PREFIX_LEN);
    expect(k.secret).toHaveLength(SECRET_LEN);
    expect(k.hash).toHaveLength(64); // SHA-256 hex
    // Lowercase base32 alphabet — no padding, no upper, no `0` / `1` / `8` / `9`.
    expect(k.prefix).toMatch(/^[a-z2-7]+$/);
    expect(k.secret).toMatch(/^[a-z2-7]+$/);
  });

  it("parseApiKey round-trips a generated key", () => {
    const k = generateApiKey();
    expect(parseApiKey(k.plaintext)).toEqual({ prefix: k.prefix, secret: k.secret });
    // Bearer prefix tolerated.
    expect(parseApiKey(`Bearer ${k.plaintext}`)).toEqual({
      prefix: k.prefix,
      secret: k.secret,
    });
    // Mixed case + surrounding whitespace tolerated.
    expect(parseApiKey(`  BEARER ${k.plaintext.toUpperCase()}  `)).toEqual({
      prefix: k.prefix,
      secret: k.secret,
    });
  });

  it("parseApiKey rejects malformed inputs", () => {
    expect(parseApiKey(null)).toBeNull();
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("ack_short_secret")).toBeNull();
    expect(parseApiKey("wrong_brand_abc_secret-with-32-chars-aaaaaaaaaaaaaaaa")).toBeNull();
    // Wrong segment count.
    expect(parseApiKey("ack_abcabcabcabca")).toBeNull();
    // Non-base32 chars.
    expect(parseApiKey("ack_!!!!!!!!!!!!!_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("hashesMatch is constant-time-friendly: returns false on length mismatch", () => {
    expect(hashesMatch("abc", "abcd")).toBe(false);
    expect(hashesMatch("a".repeat(64), "b".repeat(64))).toBe(false);
    const h = "a".repeat(64);
    expect(hashesMatch(h, h)).toBe(true);
  });

  it("computeHash is deterministic on (prefix, secret)", () => {
    const k = generateApiKey();
    expect(computeHash(k.prefix, k.secret)).toBe(k.hash);
    expect(computeHash(k.prefix, k.secret)).toBe(computeHash(k.prefix, k.secret));
    expect(computeHash(k.prefix, "different")).not.toBe(k.hash);
  });
});

describe("api keys :: scopes", () => {
  it("assertAssignable rejects empty scope list", () => {
    expect(() => assertAssignable("FIRM_ADMIN", [])).toThrowError(ScopeError);
  });

  it("assertAssignable accepts wildcard alone, rejects wildcard + named", () => {
    expect(() => assertAssignable("FIRM_ADMIN", ["*"])).not.toThrow();
    expect(() => assertAssignable("FIRM_ADMIN", ["*", "audit:read"])).toThrowError(ScopeError);
  });

  it("assertAssignable rejects scopes whose underlying permission the role lacks", () => {
    // USER does not hold "audit:read" → cannot grant audit:read on a key.
    expect(() => assertAssignable("USER", ["audit:read"])).toThrowError(ScopeError);
    // USER holds "draft:read:self" → drafts:read is assignable.
    expect(() => assertAssignable("USER", ["drafts:read"])).not.toThrow();
  });

  it("assertAssignable rejects unknown scopes", () => {
    expect(() => assertAssignable("FIRM_ADMIN", ["not-a-real-scope"])).toThrowError(ScopeError);
  });

  it("scopeAllows respects current role even with wildcard", () => {
    // A wildcard key issued by a FIRM_ADMIN, whose creator then gets
    // downgraded to USER, can no longer read audit (USER doesn't have
    // audit:read).
    expect(scopeAllows(["*"], "FIRM_ADMIN", "audit:read")).toBe(true);
    expect(scopeAllows(["*"], "USER", "audit:read")).toBe(false);
  });

  it("scopeAllows requires explicit grant when not wildcard", () => {
    expect(scopeAllows(["audit:read"], "FIRM_ADMIN", "audit:read")).toBe(true);
    expect(scopeAllows(["audit:read"], "FIRM_ADMIN", "webhooks:read")).toBe(false);
  });
});

describe("api keys :: store", () => {
  it("createApiKey persists hash (not secret) and writes API_KEY_CREATED audit", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });

    const created = await createApiKey({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      actorRole: "FIRM_ADMIN",
      name: "Test SIEM",
      scopes: ["audit:read"],
    });

    expect(created.plaintext).toMatch(/^ack_[a-z2-7]+_[a-z2-7]+$/);
    // The returned public shape must not carry the hash.
    expect("hash" in (created.apiKey as object)).toBe(false);
    // The DB row carries hash but not plaintext.
    const row = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(row).not.toBeNull();
    expect(row!.hash).not.toEqual(created.plaintext);
    expect(row!.hash).toHaveLength(64);

    // Audit chain — find by subject id.
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id, eventType: "API_KEY_CREATED" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorMembershipId).toBe(membership.id);
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.prefix).toBe(created.apiKey.prefix);
    expect(payload.scopes).toEqual(["audit:read"]);
  });

  it("createApiKey rejects expiresAt in the past and >5y future", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const base = {
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      actorRole: "FIRM_ADMIN" as const,
      name: "Test",
      scopes: ["audit:read"],
    };
    await expect(
      createApiKey({ ...base, expiresAt: new Date(Date.now() - 60_000) }),
    ).rejects.toThrowError(ApiKeyValidationError);
    await expect(
      createApiKey({ ...base, expiresAt: new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000) }),
    ).rejects.toThrowError(ApiKeyValidationError);
  });

  it("listApiKeysForTenant is tenant-isolated", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: ma } = await createTestUserAndMembership(tenantA.id, { role: "FIRM_ADMIN" });
    const { membership: mb } = await createTestUserAndMembership(tenantB.id, { role: "FIRM_ADMIN" });

    const a = await createApiKey({ tenantId: tenantA.id, actorMembershipId: ma.id, actorRole: "FIRM_ADMIN", name: "A", scopes: ["audit:read"] });
    const b = await createApiKey({ tenantId: tenantB.id, actorMembershipId: mb.id, actorRole: "FIRM_ADMIN", name: "B", scopes: ["audit:read"] });

    const aList = await listApiKeysForTenant(tenantA.id);
    const bList = await listApiKeysForTenant(tenantB.id);
    expect(aList.find((k) => k.id === a.apiKey.id)).toBeTruthy();
    expect(aList.find((k) => k.id === b.apiKey.id)).toBeFalsy();
    expect(bList.find((k) => k.id === b.apiKey.id)).toBeTruthy();
    expect(bList.find((k) => k.id === a.apiKey.id)).toBeFalsy();
  });
});

describe("api keys :: authenticateApiKey", () => {
  it("returns the resolved context on a valid key", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      actorRole: "FIRM_ADMIN",
      name: "T",
      scopes: ["audit:read"],
    });
    const parsed = parseApiKey(created.plaintext)!;
    const auth = await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    expect(auth).not.toBeNull();
    expect(auth!.membership.id).toBe(membership.id);
    expect(auth!.membership.role).toBe("FIRM_ADMIN");
    expect(auth!.apiKey.scopes).toEqual(["audit:read"]);
  });

  it("rejects on hash mismatch", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    const parsed = parseApiKey(created.plaintext)!;
    // Same prefix, different (random) secret.
    const auth = await authenticateApiKey({ prefix: parsed.prefix, secret: "x".repeat(SECRET_LEN) });
    expect(auth).toBeNull();
  });

  it("rejects revoked keys", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    await revokeApiKey({ tenantId: tenant.id, keyId: created.apiKey.id, actorMembershipId: membership.id, reason: "user-revoke" });
    const parsed = parseApiKey(created.plaintext)!;
    const auth = await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    expect(auth).toBeNull();
  });

  it("rejects expired keys", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Backdate expiresAt to the past directly in the DB.
    await superDb.apiKey.update({
      where: { id: created.apiKey.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const parsed = parseApiKey(created.plaintext)!;
    const auth = await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    expect(auth).toBeNull();
  });

  it("rejects keys whose creator-Membership has gone inactive", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    await superDb.membership.update({
      where: { id: membership.id },
      data: { status: "SUSPENDED" },
    });
    const parsed = parseApiKey(created.plaintext)!;
    const auth = await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    expect(auth).toBeNull();
  });

  it("updates lastUsedAt on first hit and skips it within 60s", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    const parsed = parseApiKey(created.plaintext)!;
    await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    const after1 = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(after1!.lastUsedAt).not.toBeNull();
    const firstSeen = after1!.lastUsedAt!.getTime();

    // Second hit within 60s — no write.
    await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    const after2 = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(after2!.lastUsedAt!.getTime()).toBe(firstSeen);

    // Backdate so the throttle window has passed, then expect a fresh write.
    await superDb.apiKey.update({
      where: { id: created.apiKey.id },
      data: { lastUsedAt: new Date(Date.now() - 5 * 60_000) },
    });
    await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret });
    const after3 = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(after3!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 30_000);
  });
});

describe("api keys :: revokeApiKey", () => {
  it("user-revoke writes API_KEY_REVOKED + sets revokedBy + reason", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    const result = await revokeApiKey({
      tenantId: tenant.id, keyId: created.apiKey.id,
      actorMembershipId: membership.id, reason: "user-revoke",
    });
    expect(result.alreadyRevoked).toBe(false);
    const row = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedById).toBe(membership.id);
    expect(row!.revokedReason).toBe("user-revoke");
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id, eventType: "API_KEY_REVOKED" },
    });
    expect(audit).not.toBeNull();
  });

  it("membership-inactive reason writes API_KEY_AUTO_REVOKED", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    await revokeApiKey({
      tenantId: tenant.id, keyId: created.apiKey.id,
      actorMembershipId: null, reason: "membership-inactive",
    });
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id, eventType: "API_KEY_AUTO_REVOKED" },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("membership-inactive");
    expect(payload.systemRevocation).toBe(true);
  });

  it("is idempotent on already-revoked rows", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    await revokeApiKey({ tenantId: tenant.id, keyId: created.apiKey.id, actorMembershipId: membership.id, reason: "user-revoke" });
    const second = await revokeApiKey({ tenantId: tenant.id, keyId: created.apiKey.id, actorMembershipId: membership.id, reason: "user-revoke" });
    expect(second.alreadyRevoked).toBe(true);
    const auditCount = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id, eventType: "API_KEY_REVOKED" },
    });
    expect(auditCount).toBe(1);
  });

  it("refuses cross-tenant revoke (silent no-op)", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: ma } = await createTestUserAndMembership(tenantA.id, { role: "FIRM_ADMIN" });
    const { membership: mb } = await createTestUserAndMembership(tenantB.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenantA.id, actorMembershipId: ma.id, actorRole: "FIRM_ADMIN",
      name: "A", scopes: ["audit:read"],
    });
    // Tenant B FIRM_ADMIN attempts to revoke A's key via the lib (mis-wired
    // caller). Should silently no-op rather than mutate cross-tenant.
    const result = await revokeApiKey({
      tenantId: tenantB.id, keyId: created.apiKey.id,
      actorMembershipId: mb.id, reason: "admin-revoke",
    });
    expect(result.alreadyRevoked).toBe(true);
    const row = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(row!.revokedAt).toBeNull();
  });
});

describe("api keys :: sweepInactiveOrExpiredApiKeys", () => {
  it("revokes keys whose creator went inactive", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"],
    });
    await superDb.membership.update({
      where: { id: membership.id },
      data: { status: "ANONYMISED" },
    });
    const result = await sweepInactiveOrExpiredApiKeys();
    expect(result.revokedForInactivity).toBeGreaterThanOrEqual(1);
    const row = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedReason).toBe("membership-inactive");
  });

  it("revokes keys past expiry; second run is a no-op", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    const created = await createApiKey({
      tenantId: tenant.id, actorMembershipId: membership.id, actorRole: "FIRM_ADMIN",
      name: "T", scopes: ["audit:read"], expiresAt: new Date(Date.now() + 60_000),
    });
    await superDb.apiKey.update({
      where: { id: created.apiKey.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const first = await sweepInactiveOrExpiredApiKeys();
    expect(first.revokedForExpiry).toBeGreaterThanOrEqual(1);
    const row = await superDb.apiKey.findUnique({ where: { id: created.apiKey.id } });
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedReason).toBe("expired");

    // Second run: row is already revoked → no additional audit, no further
    // mutation.
    const before = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id },
    });
    await sweepInactiveOrExpiredApiKeys();
    const after = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, subjectType: "ApiKey", subjectId: created.apiKey.id },
    });
    expect(after).toBe(before);
  });
});
