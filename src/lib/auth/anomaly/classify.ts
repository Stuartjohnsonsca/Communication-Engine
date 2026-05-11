import { describeUserAgent } from "@/lib/auth/sessions/ua";

/**
 * Sign-in anomaly classifier (post-PRD hardening item 21).
 *
 * Pure function — given a candidate session's UA + IP and the User's prior
 * session history, decide whether to alert.
 *
 *   'first-session' — every User signs in for the first time once; alerting
 *                     on it is noise. The check exists so the integration
 *                     test surface can distinguish "no prior sessions" from
 *                     "doesn't match prior sessions".
 *   'familiar'      — both the UA family (browser/OS pair) AND the IP block
 *                     (first /24 for v4, first /48 for v6) match at least
 *                     one prior session within the lookback window.
 *   'new-device'    — UA family OR IP block doesn't match any prior session.
 *                     `reasons` carries which dimension(s) drifted so the
 *                     audit + notification can spell out "new browser" /
 *                     "new IP block" / "new browser and new IP block".
 *
 * Lookback default is 90 days — a User who hasn't signed in from the office
 * laptop for 3 months gets a "new device" alert when they come back, which
 * is a reasonable forensic floor. Tunable per call so a future per-tenant
 * preference can extend it.
 *
 * Spoofing posture: an attacker who steals a magic-link email can re-craft
 * UA + IP to match a prior session and dodge detection. We accept this —
 * the goal of `'new-device'` is to catch the OPPORTUNISTIC case (token
 * leak + new geography) without claiming to defeat a determined attacker.
 * For the determined case, TOTP + IP allowlist + step-up handle prevention.
 */

export type ClassifyInput = {
  currentUserAgent: string | null | undefined;
  currentIp: string | null | undefined;
  /// Prior sessions for the same User, in any order — caller filters to
  /// non-revoked + within lookback window. `currentSessionId` is excluded.
  priorSessions: Array<{
    userAgent: string | null;
    ipAddress: string | null;
  }>;
};

export type ClassifyResult = {
  kind: "first-session" | "familiar" | "new-device";
  /// Always populated; empty when kind !== 'new-device'.
  reasons: Array<"new-browser-os" | "new-ip-block">;
  /// UA family computed from currentUserAgent — surfaced so callers don't
  /// re-classify if they need it for audit / notification copy.
  currentFamily: string;
  currentIpBlock: string | null;
};

export const DEFAULT_LOOKBACK_DAYS = 90;

/**
 * Browser+OS family derived from a UA string. Two sessions with the same
 * family are treated as the same "device class" for anomaly purposes — we
 * deliberately don't compare version numbers because a Chrome auto-update
 * shouldn't trip a new-device alert.
 */
export function uaFamily(ua: string | null | undefined): string {
  const s = describeUserAgent(ua ?? null);
  return `${s.browser}/${s.os}`;
}

/**
 * Coarse IP "block" — first /24 for v4, first /48 (3 hextets) for v6. Two
 * sessions from the same household IP / same corporate egress hash to the
 * same block. Returns null on parse failure so the classifier ignores the
 * IP dimension rather than alerting on garbage.
 */
export function ipBlock(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "unknown") return null;
  if (trimmed === "127.0.0.1" || trimmed === "::1" || trimmed === "localhost") {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    // IPv6 — drop zone id and take first 3 hextets.
    const noZone = trimmed.split("%")[0]!;
    const parts = noZone.split(":");
    const meaningful = parts.filter((p) => p.length > 0);
    if (meaningful.length < 1) return null;
    return meaningful.slice(0, 3).join(":") + "::/48";
  }
  const v4 = trimmed.split(".");
  if (v4.length !== 4 || v4.some((part) => !/^\d{1,3}$/.test(part))) return null;
  return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
}

export function classifySignIn(input: ClassifyInput): ClassifyResult {
  const currentFamily = uaFamily(input.currentUserAgent);
  const currentIpBlock = ipBlock(input.currentIp);

  if (input.priorSessions.length === 0) {
    return { kind: "first-session", reasons: [], currentFamily, currentIpBlock };
  }

  let familyMatched = false;
  let ipMatched = false;
  for (const p of input.priorSessions) {
    if (!familyMatched && uaFamily(p.userAgent) === currentFamily) familyMatched = true;
    const prevBlock = ipBlock(p.ipAddress);
    if (!ipMatched && prevBlock !== null && currentIpBlock !== null && prevBlock === currentIpBlock) {
      ipMatched = true;
    }
    if (familyMatched && ipMatched) break;
  }

  const reasons: ClassifyResult["reasons"] = [];
  if (!familyMatched) reasons.push("new-browser-os");
  if (!ipMatched) reasons.push("new-ip-block");

  if (reasons.length === 0) {
    return { kind: "familiar", reasons, currentFamily, currentIpBlock };
  }
  return { kind: "new-device", reasons, currentFamily, currentIpBlock };
}
