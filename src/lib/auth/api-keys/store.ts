import type { ApiKey, Role, MembershipStatus } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { computeHash, generateApiKey, hashesMatch } from "./secret";
import { assertAssignable } from "./scopes";

/**
 * CRUD for ApiKey. Mutations write a tenant-chain audit event so revocation
 * and creation are accountable. Lookup is on the indexed `prefix` column +
 * a constant-time hash compare.
 *
 * The shape `Omit<ApiKey, "hash">` is used everywhere a key is returned to
 * the application — `hash` is the secret-derived field and is never leaked
 * past this module. The full plaintext key (`createResult.plaintext`) is
 * returned by `createApiKey` once and never again; callers must immediately
 * surface it to the user and drop it from memory.
 */

const MAX_NAME = 120;

export type PublicApiKey = Omit<ApiKey, "hash">;

export type CreateApiKeyInput = {
  tenantId: string;
  actorMembershipId: string;
  actorRole: Role;
  name: string;
  scopes: string[];
  expiresAt?: Date | null;
};

export type CreateApiKeyResult = {
  apiKey: PublicApiKey;
  /** Plaintext key — surface to the user EXACTLY ONCE. */
  plaintext: string;
};

export class ApiKeyValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyValidationError";
  }
}

function strip(row: ApiKey): PublicApiKey {
  const { hash: _hash, ...rest } = row;
  return rest;
}

function normaliseScopes(input: readonly string[]): string[] {
  const cleaned = input.map((s) => s.trim()).filter((s) => s.length > 0);
  return Array.from(new Set(cleaned));
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const name = input.name.trim();
  if (!name) throw new ApiKeyValidationError("name is required");
  if (name.length > MAX_NAME) throw new ApiKeyValidationError(`name must be ≤ ${MAX_NAME} chars`);
  const scopes = normaliseScopes(input.scopes);
  assertAssignable(input.actorRole, scopes);

  // expiresAt clamp — refuse anything in the past (clock-skew tolerance
  // 30s) and anything > 5 years out (sensible operational ceiling).
  if (input.expiresAt) {
    const now = Date.now();
    const t = input.expiresAt.getTime();
    if (t < now - 30_000) throw new ApiKeyValidationError("expiresAt must be in the future");
    const FIVE_YEARS = 5 * 365 * 24 * 60 * 60 * 1000;
    if (t - now > FIVE_YEARS) throw new ApiKeyValidationError("expiresAt must be within 5 years");
  }

  const { plaintext, prefix, hash, version } = generateApiKey();

  const row = await superDb.apiKey.create({
    data: {
      tenantId: input.tenantId,
      name,
      prefix,
      hash,
      keyVersion: version,
      scopes,
      expiresAt: input.expiresAt ?? null,
      createdByMembershipId: input.actorMembershipId,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "API_KEY_CREATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ApiKey",
    subjectId: row.id,
    payload: {
      name,
      prefix,
      scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    },
  });

  return { apiKey: strip(row), plaintext };
}

export type RevokeReason = "user-revoke" | "admin-revoke" | "membership-inactive" | "expired";

export async function revokeApiKey(opts: {
  tenantId: string;
  keyId: string;
  actorMembershipId: string | null;
  reason: RevokeReason;
}): Promise<{ alreadyRevoked: boolean }> {
  const existing = await superDb.apiKey.findUnique({
    where: { id: opts.keyId },
    select: { id: true, tenantId: true, revokedAt: true, prefix: true, name: true },
  });
  if (!existing) return { alreadyRevoked: true };
  if (existing.tenantId !== opts.tenantId) return { alreadyRevoked: true };
  if (existing.revokedAt) return { alreadyRevoked: true };

  await superDb.apiKey.update({
    where: { id: opts.keyId },
    data: {
      revokedAt: new Date(),
      revokedById: opts.actorMembershipId,
      revokedReason: opts.reason,
    },
  });

  await writeAuditEvent({
    tenantId: opts.tenantId,
    eventType: opts.reason === "membership-inactive" ? "API_KEY_AUTO_REVOKED" : "API_KEY_REVOKED",
    actorMembershipId: opts.actorMembershipId,
    subjectType: "ApiKey",
    subjectId: opts.keyId,
    payload: {
      name: existing.name,
      prefix: existing.prefix,
      reason: opts.reason,
      systemRevocation: opts.actorMembershipId === null,
    },
  });

  return { alreadyRevoked: false };
}

export async function listApiKeysForTenant(tenantId: string, opts?: { includeRevoked?: boolean }) {
  const rows = await superDb.apiKey.findMany({
    where: {
      tenantId,
      ...(opts?.includeRevoked ? {} : { revokedAt: null }),
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(strip);
}

export type AuthenticatedApiKey = {
  apiKey: PublicApiKey;
  /** The creator-Membership's CURRENT role + status (not at-issuance). */
  membership: {
    id: string;
    tenantId: string;
    userId: string;
    role: Role;
    status: MembershipStatus;
  };
};

/**
 * Look up a presented key, verify the hash, check revocation + expiry +
 * creator-Membership status. Returns null on every failure mode (no
 * auth context for the route to operate against). The caller is
 * expected to write `API_KEY_AUTH_FAILED` audit on null — that's
 * surfaced separately via `recordAuthFailure`.
 *
 * Throttled lastUsedAt: only writes when older than 60s. Same shape as
 * Session.lastSeenAt (item 13).
 */
export async function authenticateApiKey(opts: {
  prefix: string;
  secret: string;
  presentedIp?: string | null;
}): Promise<AuthenticatedApiKey | null> {
  const row = await superDb.apiKey.findUnique({
    where: { prefix: opts.prefix },
    include: {
      createdBy: {
        select: { id: true, tenantId: true, userId: true, role: true, status: true },
      },
    },
  });
  if (!row) return null;

  // Constant-time hash compare. Order is important: revocation /
  // expiry / membership checks are AFTER the hash check so a caller
  // cannot infer that a prefix exists by timing the response.
  // `keyVersion` selects the right HMAC key — legacy "v1" keys verify
  // against the original env-string posture; v2+ verifies against the
  // 32-byte AES key from the registry (see `lib/crypto/keys.ts`).
  const expected = computeHash(opts.prefix, opts.secret, row.keyVersion);
  if (!hashesMatch(row.hash, expected)) return null;

  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  const membership = row.createdBy;
  if (!membership) return null;
  // Creator-Membership must still be active. INACTIVE here covers
  // SUSPENDED / LEAVER_FROZEN / ANONYMISED — the lifecycle sweep will
  // also auto-revoke the row but we belt-and-brace here so a key
  // issued seconds before deactivation can't ride through until the
  // sweep notices.
  if (membership.status !== "ACTIVE") return null;

  // Throttled lastUsedAt — at most one write per 60s per key.
  const SIXTY_S = 60 * 1000;
  const stale = !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > SIXTY_S;
  if (stale) {
    // Conditional UPDATE serialised at the row level. The where clause
    // makes a duplicate-write race no-op rather than triggering a write.
    await superDb.apiKey.updateMany({
      where: {
        id: row.id,
        OR: [
          { lastUsedAt: null },
          { lastUsedAt: { lt: new Date(Date.now() - SIXTY_S) } },
        ],
      },
      data: {
        lastUsedAt: new Date(),
        lastUsedIp: opts.presentedIp ?? row.lastUsedIp,
      },
    });
  }

  return {
    apiKey: strip(row),
    membership: {
      id: membership.id,
      tenantId: membership.tenantId,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
    },
  };
}

/**
 * Record a failed auth attempt. Throttled to once per (prefix, hour) to
 * keep the chain bounded under a brute-force probe — same posture as
 * RATE_LIMIT_EXCEEDED throttling.
 */
export async function recordAuthFailure(opts: {
  tenantId: string;
  prefix: string;
  reason: "unknown-prefix" | "hash-mismatch" | "revoked" | "expired" | "membership-inactive" | "malformed" | "scope-denied";
  ip?: string | null;
}): Promise<void> {
  await writeAuditEvent({
    tenantId: opts.tenantId,
    eventType: "API_KEY_AUTH_FAILED",
    actorMembershipId: null,
    subjectType: "ApiKey",
    subjectId: opts.prefix,
    payload: {
      prefix: opts.prefix,
      reason: opts.reason,
      ip: opts.ip ?? null,
    },
  });
}

/**
 * Lifecycle sweep — auto-revoke every ApiKey whose creator-Membership
 * has gone INACTIVE since the last sweep, or whose expiresAt has
 * passed. Idempotent: revoked rows are skipped.
 *
 * Called from `/api/cron/lifecycle-sweep` once per minute.
 */
export async function sweepInactiveOrExpiredApiKeys(): Promise<{
  revokedForInactivity: number;
  revokedForExpiry: number;
}> {
  // Expired first — that's the cheaper indexed query (only rows with
  // an expiresAt in the past).
  const expired = await superDb.apiKey.findMany({
    where: {
      revokedAt: null,
      expiresAt: { lt: new Date() },
    },
    select: { id: true, tenantId: true },
    take: 1000,
  });
  for (const row of expired) {
    await revokeApiKey({
      tenantId: row.tenantId,
      keyId: row.id,
      actorMembershipId: null,
      reason: "expired",
    });
  }

  // Inactive creators — join via createdByMembershipId. We pull the
  // Membership.status state directly so this works even if the
  // lifecycle sweep that flipped status didn't know about API keys.
  const inactive = await superDb.apiKey.findMany({
    where: {
      revokedAt: null,
      createdBy: { status: { not: "ACTIVE" } },
    },
    select: { id: true, tenantId: true },
    take: 1000,
  });
  for (const row of inactive) {
    await revokeApiKey({
      tenantId: row.tenantId,
      keyId: row.id,
      actorMembershipId: null,
      reason: "membership-inactive",
    });
  }

  return { revokedForExpiry: expired.length, revokedForInactivity: inactive.length };
}
