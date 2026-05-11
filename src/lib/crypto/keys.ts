import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Versioned encryption-key registry.
 *
 * The platform encrypts three categories of sensitive data with the AES key
 * resolved here:
 *   - `ChannelAuth.encryptedTokens` (OAuth tokens)
 *   - `UserTotp.secretEncrypted` (TOTP shared secret)
 *   - `WebhookSubscription.secretEncrypted` (HMAC signing secret)
 *
 * `ApiKey.hash` is a separate HMAC keyed on its own version (see
 * `src/lib/auth/api-keys/secret.ts`); rotation does NOT re-hash those rows
 * because HMACs are one-way. Each ApiKey carries a `keyVersion` so its
 * HMAC continues to verify against the key it was created with even after
 * the active AES version changes.
 *
 * Until item 27 every AES blob was encrypted with a single key sourced
 * from `ENCRYPTION_KEY`. Rotation now happens by adding a second versioned
 * key and letting the rotation script re-encrypt blobs in place.
 *
 * Env-var contract (in order of precedence):
 *
 *   ENCRYPTION_KEYS   JSON object: {"v1":"<base64-32B>","v2":"<base64-32B>"}.
 *                     Every value MUST decode to exactly 32 bytes.
 *   ENCRYPTION_KEY_ACTIVE_VERSION   Identifier of the version used for FRESH
 *                                   writes. Must exist in ENCRYPTION_KEYS.
 *                                   Defaults to the only key when there's one.
 *   ENCRYPTION_KEY    Legacy single-key fallback. Treated as `{"v1": <key>}`
 *                     with active version "v1". Kept indefinitely for
 *                     environments that haven't migrated to the JSON form.
 *
 * Blob format (encryptJson / decryptJson):
 *   - NEW format: `v<N>:<base64-iv-ct-tag>` — colon is not in the base64
 *     alphabet, so prefix detection is unambiguous.
 *   - LEGACY format: `<base64-iv-ct-tag>` (no prefix). Treated as v1.
 *
 * Why a colon delimiter: base64 alphabet is A-Z, a-z, 0-9, +, /, =. A
 * literal `:` in the first six characters of a stored blob can only come
 * from the version prefix the new encrypt path emits.
 */

const VERSION_PREFIX_RE = /^([a-z][a-z0-9]{0,15}):/;
const KEY_BYTES = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const ALG = "aes-256-gcm";

export type KeyVersion = string;

export type KeyRegistry = {
  /** Map of version id → 32-byte AES key. Frozen after construction. */
  keys: ReadonlyMap<KeyVersion, Buffer>;
  /** Version id used for fresh writes. Must exist in `keys`. */
  active: KeyVersion;
};

export class EncryptionKeyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no-key"
      | "active-not-in-registry"
      | "bad-key-bytes"
      | "bad-version-id"
      | "registry-empty"
      | "unknown-version",
  ) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/** Build a registry from explicit env-style inputs (used in tests and the rotation CLI). */
export function buildRegistry(input: {
  keysJson?: string | null;
  singleKey?: string | null;
  active?: string | null;
}): KeyRegistry {
  const keys = new Map<KeyVersion, Buffer>();

  if (input.keysJson && input.keysJson.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.keysJson);
    } catch {
      throw new EncryptionKeyError("ENCRYPTION_KEYS is not valid JSON.", "bad-key-bytes");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new EncryptionKeyError(
        "ENCRYPTION_KEYS must be a JSON object of {version: base64Key}.",
        "bad-key-bytes",
      );
    }
    for (const [v, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VERSION_PREFIX_RE.test(`${v}:`)) {
        throw new EncryptionKeyError(
          `ENCRYPTION_KEYS contains invalid version id ${JSON.stringify(v)}. ` +
            `Use lowercase ASCII starting with a letter (e.g. "v1", "v2").`,
          "bad-version-id",
        );
      }
      if (typeof raw !== "string" || !raw.trim()) {
        throw new EncryptionKeyError(
          `ENCRYPTION_KEYS["${v}"] is not a non-empty string.`,
          "bad-key-bytes",
        );
      }
      const bytes = Buffer.from(raw, "base64");
      if (bytes.length !== KEY_BYTES) {
        throw new EncryptionKeyError(
          `ENCRYPTION_KEYS["${v}"] decodes to ${bytes.length} bytes (need ${KEY_BYTES}).`,
          "bad-key-bytes",
        );
      }
      keys.set(v, bytes);
    }
  } else if (input.singleKey && input.singleKey.trim()) {
    const bytes = Buffer.from(input.singleKey, "base64");
    if (bytes.length !== KEY_BYTES) {
      throw new EncryptionKeyError(
        `ENCRYPTION_KEY decodes to ${bytes.length} bytes (need ${KEY_BYTES}).`,
        "bad-key-bytes",
      );
    }
    keys.set("v1", bytes);
  }

  if (keys.size === 0) {
    throw new EncryptionKeyError(
      "No encryption key configured. Set ENCRYPTION_KEYS (preferred) or ENCRYPTION_KEY.",
      "no-key",
    );
  }

  let active = input.active?.trim() || undefined;
  if (active && !keys.has(active)) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY_ACTIVE_VERSION="${active}" but registry does not contain that version.`,
      "active-not-in-registry",
    );
  }
  if (!active) {
    // Default: pick the highest-numbered v-prefixed version, else the only
    // key in the registry. Picking the highest version mirrors the natural
    // operator expectation — "v2" supersedes "v1" without explicit env.
    if (keys.size === 1) {
      active = [...keys.keys()][0]!;
    } else {
      const ordered = [...keys.keys()].sort(compareVersions);
      active = ordered[ordered.length - 1]!;
    }
  }

  return { keys: new Map(keys), active };
}

function compareVersions(a: string, b: string): number {
  const numA = parseInt(a.replace(/^v/, ""), 10);
  const numB = parseInt(b.replace(/^v/, ""), 10);
  if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
  return a.localeCompare(b);
}

let cachedRegistry: KeyRegistry | null = null;

/** Read the registry from the current process env. Cached after first build. */
export function getRegistry(): KeyRegistry {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = buildRegistry({
    keysJson: process.env.ENCRYPTION_KEYS ?? null,
    singleKey: process.env.ENCRYPTION_KEY ?? null,
    active: process.env.ENCRYPTION_KEY_ACTIVE_VERSION ?? null,
  });
  return cachedRegistry;
}

/** Clear the cached registry. Test-only escape hatch. */
export function _resetRegistryCache(): void {
  cachedRegistry = null;
}

function fetchKey(registry: KeyRegistry, version: KeyVersion): Buffer {
  const key = registry.keys.get(version);
  if (!key) {
    throw new EncryptionKeyError(
      `Encryption key version "${version}" not present in registry. ` +
        `Available: ${[...registry.keys.keys()].join(", ")}.`,
      "unknown-version",
    );
  }
  return key;
}

/** Parse the version prefix off a stored blob, if any. Legacy blobs → "v1". */
export function peekVersion(blob: string): KeyVersion {
  const m = blob.match(VERSION_PREFIX_RE);
  return m ? m[1]! : "v1";
}

/** True iff the blob carries an explicit `<version>:` prefix. */
export function hasVersionPrefix(blob: string): boolean {
  return VERSION_PREFIX_RE.test(blob);
}

/** Encrypt a JSON-serialisable value with the registry's active version. */
export function encryptJsonWith(registry: KeyRegistry, value: unknown): string {
  const iv = randomBytes(IV_LEN);
  const key = fetchKey(registry, registry.active);
  const cipher = createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([iv, ct, tag]).toString("base64");
  return `${registry.active}:${body}`;
}

/** Decrypt a blob using whichever key version its prefix names (legacy = v1). */
export function decryptJsonWith<T = unknown>(registry: KeyRegistry, blob: string): T {
  const m = blob.match(VERSION_PREFIX_RE);
  const version = m ? m[1]! : "v1";
  const body = m ? blob.slice(m[0].length) : blob;
  const key = fetchKey(registry, version);
  const all = Buffer.from(body, "base64");
  if (all.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("encrypted blob truncated");
  }
  const iv = all.subarray(0, IV_LEN);
  const tag = all.subarray(all.length - TAG_LEN);
  const ct = all.subarray(IV_LEN, all.length - TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as T;
}

/** Map a blob → its version. Convenience over peekVersion for batch jobs. */
export function classifyBlob(blob: string): { version: KeyVersion; legacy: boolean } {
  const m = blob.match(VERSION_PREFIX_RE);
  return { version: m ? m[1]! : "v1", legacy: !m };
}

/** Expose the registry's 32-byte AES key for a specific version. */
export function getAesKey(registry: KeyRegistry, version: KeyVersion): Buffer {
  return fetchKey(registry, version);
}
