import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers for encrypting OAuth tokens at rest in
 * `ChannelAuth.encryptedTokens` (PRD §12.7). The raw key comes from
 * `ENCRYPTION_KEY` — 32 random bytes, base64-encoded. Per-tenant key
 * isolation is a follow-up (BYOK / CMK enterprise upgrade); this is the
 * platform-default key.
 *
 * Storage format (base64): iv (12B) || ciphertext || tag (16B). One
 * dependency-free string round-trips cleanly through Postgres TEXT.
 */

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptJson<T = unknown>(blob: string): T {
  const all = Buffer.from(blob, "base64");
  if (all.length < IV_LEN + TAG_LEN + 1) throw new Error("ciphertext truncated");
  const iv = all.subarray(0, IV_LEN);
  const tag = all.subarray(all.length - TAG_LEN);
  const ct = all.subarray(IV_LEN, all.length - TAG_LEN);
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as T;
}
