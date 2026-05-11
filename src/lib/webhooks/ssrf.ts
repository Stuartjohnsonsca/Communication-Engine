/**
 * Outbound-webhook SSRF defence (post-PRD hardening).
 *
 * The config-time URL validator in `subscriptions.ts` already refuses
 * obvious mistakes (`localhost`, `10.*`, etc.). That covers the
 * fat-finger case but leaves two real attack surfaces:
 *
 *   1. DNS rebinding — a hostile receiver registers `evil.com` resolving
 *      to a public IP at config time, then flips DNS to `10.0.0.5` (or
 *      worse, `169.254.169.254` cloud-metadata) before delivery. The
 *      config-time hostname check passes; the delivery hits internal
 *      infra. This module's `assertEgressAllowed` resolves the hostname
 *      JUST BEFORE the fetch and refuses if the answer is in any private
 *      range.
 *
 *   2. Surface gaps — the config-time string checks miss IPv6 (loopback
 *      `::1`, link-local `fe80::/10`, unique-local `fc00::/7`, multicast
 *      `ff00::/8`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`), CGNAT
 *      (`100.64.0.0/10`), benchmark net (`198.18.0.0/15`), and DNS-based
 *      metadata endpoints (`metadata.google.internal`, `*.local`,
 *      `*.internal`). `isBlockedHostname` and `isPrivateIp` cover the
 *      lot.
 *
 * Residual TOCTOU: `dns.lookup` runs before `fetch`; in principle a
 * hostile authoritative nameserver could return a public IP to us and a
 * private one to the libuv resolver inside undici. The window is
 * sub-millisecond in practice and closing it fully requires pinning the
 * resolved IP via an undici `Agent.connect.lookup` callback — left as a
 * future enhancement.
 */
import { promises as dnsPromises } from "node:dns";

type DnsLookup = (
  hostname: string,
) => Promise<{ address: string; family: number }>;

const IPV4_PRIVATE_CIDRS: ReadonlyArray<readonly [readonly [number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8],        // "this network" / 0.0.0.0/8
  [[10, 0, 0, 0], 8],        // RFC1918
  [[100, 64, 0, 0], 10],     // CGNAT
  [[127, 0, 0, 0], 8],       // loopback
  [[169, 254, 0, 0], 16],    // link-local + cloud metadata (169.254.169.254)
  [[172, 16, 0, 0], 12],     // RFC1918
  [[192, 0, 0, 0], 24],      // IETF protocol assignments
  [[192, 0, 2, 0], 24],      // TEST-NET-1
  [[192, 88, 99, 0], 24],    // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16],    // RFC1918
  [[198, 18, 0, 0], 15],     // benchmarking
  [[198, 51, 100, 0], 24],   // TEST-NET-2
  [[203, 0, 113, 0], 24],    // TEST-NET-3
  [[224, 0, 0, 0], 4],       // multicast
  [[240, 0, 0, 0], 4],       // reserved (includes 255.255.255.255 broadcast)
];

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",     // mDNS / Bonjour / Avahi
  ".internal",  // GCP metadata.google.internal, common intranet suffix
];

const BLOCKED_HOSTNAME_LITERALS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.aws.com",
  "metadata.azure.com",
]);

function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]+$/.test(p)) return null;
    // Reject leading-zero octets (008 etc.) — different parsers disagree
    // on whether those are octal or decimal, and the safer answer is to
    // refuse anything ambiguous.
    if (p.length > 1 && p.startsWith("0")) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

function ipv4InCidr(
  ip: [number, number, number, number],
  base: readonly [number, number, number, number],
  bits: number,
): boolean {
  let prefix = bits;
  for (let i = 0; i < 4; i++) {
    if (prefix <= 0) break;
    const take = Math.min(8, prefix);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (base[i] & mask)) return false;
    prefix -= take;
  }
  return true;
}

export function isPrivateIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip);
  if (!parsed) return false;
  for (const [base, bits] of IPV4_PRIVATE_CIDRS) {
    if (ipv4InCidr(parsed, base, bits)) return true;
  }
  return false;
}

function parseIpv6(s: string): number[] | null {
  // Strip zone id (fe80::1%eth0). Zone-scoped addresses are by definition
  // non-routable so the rest of the function never needs them.
  const noZone = s.split("%")[0];
  // IPv4-mapped form e.g. ::ffff:1.2.3.4 — caller should detect this first,
  // but parse it here too for safety.
  const mappedMatch = /^([0-9a-fA-F:]*:)(\d+\.\d+\.\d+\.\d+)$/.exec(noZone);
  if (mappedMatch) {
    const head = mappedMatch[1].slice(0, -1); // drop trailing ":"
    const v4 = parseIpv4(mappedMatch[2]);
    if (!v4) return null;
    const headBytes = parseIpv6Hex(head);
    if (!headBytes) return null;
    if (headBytes.length + 4 !== 16) return null;
    return headBytes.concat(v4);
  }
  return parseIpv6Hex(noZone);
}

function parseIpv6Hex(s: string): number[] | null {
  if (s.length === 0) return null;
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null;
  const doubleColonCount = (s.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;
  let head: string[];
  let tail: string[];
  const doubleColonIdx = s.indexOf("::");
  if (doubleColonIdx >= 0) {
    const before = s.slice(0, doubleColonIdx);
    const after = s.slice(doubleColonIdx + 2);
    head = before ? before.split(":") : [];
    tail = after ? after.split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    head = head.concat(new Array(missing).fill("0"));
  } else {
    head = s.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }
  const groups = head.concat(tail);
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    if (!/^[0-9a-fA-F]+$/.test(g)) return null;
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  return out;
}

export function isPrivateIpv6(ip: string): boolean {
  // IPv4-mapped form: defer to v4 check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const bytes = parseIpv6(ip);
  if (!bytes || bytes.length !== 16) return false;
  // :: unspecified (all-zero)
  if (bytes.every((b) => b === 0)) return true;
  // ::1 loopback (15 zeros + 1)
  if (bytes.every((b, i) => (i < 15 ? b === 0 : b === 1))) return true;
  // fc00::/7 — unique-local (first 7 bits == 1111110)
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 — link-local (first 10 bits == 1111111010)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // ff00::/8 — multicast
  if (bytes[0] === 0xff) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  if (trimmed.includes(":")) return isPrivateIpv6(trimmed);
  return isPrivateIpv4(trimmed);
}

/**
 * Hostname-level block list. Catches things `isPrivateIp` cannot — DNS
 * names that intentionally bypass an IP-only check, mDNS / `.local`
 * intranets, and cloud-metadata DNS shortcuts.
 *
 * Bracketed IPv6 literals (`[::1]`) are unwrapped before the IP check so
 * URL hostnames pass through transparently.
 */
export function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.trim().toLowerCase();
  if (h.length === 0) return true;
  if (BLOCKED_HOSTNAME_LITERALS.has(h)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  // IPv6 in URL hostname form is wrapped in brackets — unwrap before
  // delegating to the IP check.
  if (h.startsWith("[") && h.endsWith("]")) {
    return isPrivateIp(h.slice(1, -1));
  }
  // Bare IPv4 literal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIp(h);
  // Bare IPv6 literal (rare in URL hostname position without brackets, but
  // belt-and-braces).
  if (h.includes(":")) return isPrivateIp(h);
  return false;
}

export type EgressCheckOutcome =
  | { allowed: true; resolvedIp: string }
  | { allowed: false; reason: string };

/**
 * The full delivery-time check: rejects on hostname pattern OR on a DNS
 * resolution that returns a private IP. Returns a discriminated union
 * so the caller can decide whether to retry, dead-letter, or alert.
 *
 * Accepts an optional `lookup` injection so tests can simulate DNS
 * rebinding without depending on real network state. Defaults to
 * `dns.promises.lookup` (Node's libuv-backed resolver).
 */
export async function assertEgressAllowed(
  hostname: string,
  opts: { lookup?: DnsLookup } = {},
): Promise<EgressCheckOutcome> {
  if (isBlockedHostname(hostname)) {
    return { allowed: false, reason: "hostname blocked (private/loopback/metadata)" };
  }
  const lookup =
    opts.lookup ??
    (async (h: string) => {
      const r = await dnsPromises.lookup(h);
      return { address: r.address, family: r.family };
    });
  let address: string;
  try {
    const r = await lookup(hostname);
    address = r.address;
  } catch (err) {
    return {
      allowed: false,
      reason: `dns lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!address) {
    return { allowed: false, reason: "dns returned no address" };
  }
  if (isPrivateIp(address)) {
    return { allowed: false, reason: `resolved IP ${address} is private` };
  }
  return { allowed: true, resolvedIp: address };
}

/**
 * Stream-and-cap a Response body. Naïve `await res.text()` reads the
 * whole body before any truncation — a hostile receiver can return a
 * multi-GB body and OOM the worker. This reader pulls one chunk at a
 * time and aborts the stream once the cap is reached.
 *
 * Returns the decoded text plus a `truncated` flag so callers can mark
 * the storage truncation in their logs / audit payloads.
 */
export async function readBodyWithCap(
  res: Response,
  capBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  if (!res.body) {
    return { text: "", truncated: false, bytesRead: 0 };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > capBytes) {
        truncated = true;
        // Trim the final chunk so we end exactly at the cap.
        const overflow = bytesRead - capBytes;
        const fits = value.byteLength - overflow;
        if (fits > 0) {
          chunks.push(value.subarray(0, fits));
        }
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Mid-stream error — surface whatever we already buffered. The fetch
    // outcome (status code or thrown error) is independent of this read.
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  return { text, truncated, bytesRead };
}
