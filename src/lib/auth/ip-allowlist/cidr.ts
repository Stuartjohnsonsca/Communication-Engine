/**
 * Pure CIDR parsing + matching for IPv4 and IPv6. No external
 * dependency — Node's `node:net` would be sufficient for parsing but
 * not for prefix-matching, and pulling in `ip-cidr` or similar for
 * what's a ~80 line problem isn't justified.
 *
 * Two public functions:
 *   - `parseCidr(s)` returns a normalised representation or `null` if
 *     the input is malformed. Used by the admin form to reject bad
 *     entries before they reach the DB.
 *   - `ipInCidr(ip, cidr)` checks membership. Used by the runtime
 *     enforcer.
 *
 * For convenience, `ipInAnyCidr(ip, cidrs[])` short-circuits on first
 * match and returns false when the list is empty (caller decides
 * whether empty means "no restriction" or "deny all" — this module
 * doesn't have an opinion; both callers in this codebase treat empty
 * as "no restriction").
 *
 * The matcher works on raw byte buffers (4 bytes for v4, 16 for v6)
 * and a prefix length in bits. We compare full bytes for the
 * floor(prefix/8) bytes and mask the leftmost remaining bits in the
 * trailing byte.
 *
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to its IPv4 form
 * before matching, so an admin who writes a v4 CIDR doesn't have to
 * also write the v6-mapped equivalent for cloud proxies that
 * upgrade-in-place.
 */

export type ParsedCidr = {
  /** Original input as supplied (after trim). */
  original: string;
  family: "v4" | "v6";
  /** Network bytes (4 for v4, 16 for v6) with host bits zeroed. */
  network: Uint8Array;
  prefix: number;
};

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    // Reject leading-zero octets like "01" — common typo, ambiguous.
    if (p.length > 1 && p.startsWith("0")) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): Uint8Array | null {
  // Normalise IPv4-mapped form: `::ffff:1.2.3.4` → 16 bytes ending v4.
  // Reject anything with a v4 segment outside the trailing-32-bits
  // position to keep parsing simple.
  const v4Mapped = s.match(/^(.*?:):?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let head = s;
  let tail: Uint8Array | null = null;
  if (v4Mapped) {
    head = v4Mapped[1].replace(/:$/, "");
    tail = parseIpv4(v4Mapped[2]);
    if (!tail) return null;
  }

  const doubleColonSplit = head.split("::");
  if (doubleColonSplit.length > 2) return null; // more than one `::`
  const leftParts = doubleColonSplit[0] ? doubleColonSplit[0].split(":") : [];
  const rightParts =
    doubleColonSplit.length === 2 && doubleColonSplit[1] ? doubleColonSplit[1].split(":") : [];

  const expectedHextets = tail ? 6 : 8;
  const present = leftParts.length + rightParts.length;
  if (doubleColonSplit.length === 1) {
    if (present !== expectedHextets) return null;
  } else if (present > expectedHextets) {
    return null;
  }

  const allHextets: string[] = new Array(expectedHextets).fill("0");
  for (let i = 0; i < leftParts.length; i++) allHextets[i] = leftParts[i];
  for (let i = 0; i < rightParts.length; i++) {
    allHextets[expectedHextets - rightParts.length + i] = rightParts[i];
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < expectedHextets; i++) {
    const h = allHextets[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    const n = Number.parseInt(h, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) {
    out[12] = tail[0];
    out[13] = tail[1];
    out[14] = tail[2];
    out[15] = tail[3];
  }
  return out;
}

function applyPrefixMask(bytes: Uint8Array, prefix: number): Uint8Array {
  const masked = new Uint8Array(bytes.length);
  const fullBytes = Math.floor(prefix / 8);
  const remainderBits = prefix % 8;
  for (let i = 0; i < fullBytes; i++) masked[i] = bytes[i];
  if (remainderBits > 0 && fullBytes < bytes.length) {
    const mask = (0xff << (8 - remainderBits)) & 0xff;
    masked[fullBytes] = bytes[fullBytes] & mask;
  }
  return masked;
}

export function parseCidr(input: string): ParsedCidr | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // CIDR-less single addresses are interpreted as /32 (v4) or /128
  // (v6). Procurement reviewers often hand over a list of static
  // host IPs without slashes.
  const slashIdx = trimmed.indexOf("/");
  const ipPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const prefixPart = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1);

  // Try v4 first.
  const v4 = parseIpv4(ipPart);
  if (v4) {
    const prefix = prefixPart == null ? 32 : Number.parseInt(prefixPart, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
    if (prefixPart != null && !/^\d+$/.test(prefixPart)) return null;
    return { original: trimmed, family: "v4", network: applyPrefixMask(v4, prefix), prefix };
  }

  // Then v6.
  const v6 = parseIpv6(ipPart);
  if (v6) {
    const prefix = prefixPart == null ? 128 : Number.parseInt(prefixPart, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 128) return null;
    if (prefixPart != null && !/^\d+$/.test(prefixPart)) return null;
    return { original: trimmed, family: "v6", network: applyPrefixMask(v6, prefix), prefix };
  }

  return null;
}

function parseIpAddress(input: string): { family: "v4" | "v6"; bytes: Uint8Array } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const v4 = parseIpv4(trimmed);
  if (v4) return { family: "v4", bytes: v4 };
  const v6 = parseIpv6(trimmed);
  if (v6) {
    // Normalise v4-mapped v6 (`::ffff:1.2.3.4`) to v4 for matching: if
    // bytes 0..9 are zero AND bytes 10..11 are 0xff, treat the last 4
    // bytes as v4 so a v4 CIDR matches.
    let allZero = true;
    for (let i = 0; i < 10; i++) if (v6[i] !== 0) { allZero = false; break; }
    if (allZero && v6[10] === 0xff && v6[11] === 0xff) {
      return { family: "v4", bytes: v6.slice(12) };
    }
    return { family: "v6", bytes: v6 };
  }
  return null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIpAddress(ip);
  if (!parsedIp) return false;
  const parsedCidr = parseCidr(cidr);
  if (!parsedCidr) return false;
  if (parsedIp.family !== parsedCidr.family) return false;
  const ipMasked = applyPrefixMask(parsedIp.bytes, parsedCidr.prefix);
  if (ipMasked.length !== parsedCidr.network.length) return false;
  for (let i = 0; i < ipMasked.length; i++) {
    if (ipMasked[i] !== parsedCidr.network[i]) return false;
  }
  return true;
}

/**
 * Returns true if `ip` matches at least one entry in `cidrs`. Empty
 * list returns false — the caller decides what "empty" means in their
 * context.
 *
 * Malformed entries in `cidrs` are skipped silently — by the time a
 * value reaches this function it's already been validated by the
 * admin form. Skipping rather than throwing keeps a single corrupted
 * row from locking everyone out.
 */
export function ipInAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return false;
  for (const c of cidrs) {
    if (ipInCidr(ip, c)) return true;
  }
  return false;
}

/**
 * Best-effort canonicalisation. Doesn't try to lower-case or
 * compress IPv6 zero runs — the matcher operates on bytes so the
 * stored string is just for display. Returns the original (trimmed)
 * if it parses, null if it doesn't.
 */
export function canonicaliseCidr(input: string): string | null {
  const parsed = parseCidr(input);
  if (!parsed) return null;
  // For v4 single hosts written without a slash, expand to /32 so
  // display is unambiguous.
  if (parsed.family === "v4" && !parsed.original.includes("/")) {
    return `${parsed.original}/32`;
  }
  if (parsed.family === "v6" && !parsed.original.includes("/")) {
    return `${parsed.original}/128`;
  }
  return parsed.original;
}
