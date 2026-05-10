import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Recovery codes are emitted at enrollment time (and only at enrollment
 * time — the User must save them). Stored hashed with HMAC-SHA256 keyed
 * off ENCRYPTION_KEY so a row-level leak of `recoveryCodesHashed` is not
 * directly reversible without also exfiltrating the platform key.
 *
 * Each code is 10 lowercase hex chars (40 bits = ~10^12 combos per code,
 * total combo space ~10^121 across 10 codes) formatted as `xxxxx-xxxxx`
 * so it's tolerable to type. Codes are single-use: on successful verify
 * we remove the matching hash from the row.
 */

const CODE_BYTES = 5; // 5 bytes = 10 hex chars

export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const buf = randomBytes(CODE_BYTES);
    const hex = buf.toString("hex"); // 10 chars
    out.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}`);
  }
  return out;
}

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

/** Normalise: strip whitespace and dashes, lowercase. */
function normalise(code: string): string {
  return code.replace(/[\s-]/g, "").toLowerCase();
}

export function hashRecoveryCode(code: string): string {
  return createHmac("sha256", key()).update(normalise(code)).digest("hex");
}

/**
 * Constant-time check: does the candidate code match any hash in the list?
 * Returns the index of the matched hash, or -1 on no match. Caller is
 * responsible for splicing the consumed hash out of the row (single-use).
 */
export function findMatchingHashIndex(code: string, hashes: readonly string[]): number {
  const candidate = Buffer.from(hashRecoveryCode(code), "hex");
  for (let i = 0; i < hashes.length; i += 1) {
    let known: Buffer;
    try {
      known = Buffer.from(hashes[i], "hex");
    } catch {
      continue;
    }
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      return i;
    }
  }
  return -1;
}
