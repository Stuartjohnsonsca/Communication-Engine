import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { maskIp } from "@/lib/auth/sessions/ip";
import { ipInAnyCidr, canonicaliseCidr } from "./cidr";

/**
 * Runtime enforcement of the tenant IP allowlist.
 *
 * Empty list = no restriction. Any single match short-circuits to
 * allowed. A non-empty list with zero matches denies and writes
 * `IP_ALLOWLIST_DENIED` to the tenant chain (throttled to once per
 * (tenantId, masked-ip, hour) so a probe can't fill the chain).
 *
 * `localhost` and other loopback addresses are intentionally NOT
 * exempted — operating-mode parity. If an admin is testing locally
 * with an allowlist configured, they need to include 127.0.0.1 (or
 * ::1) themselves; this prevents the surprise of "it works in dev
 * but not in production" when an allowlist is in play.
 *
 * On a transient DB error during the audit write, the request is
 * still denied (the allowlist evaluation already happened in memory
 * against the cached tenant row); audit failure is logged via
 * `reportError`.
 */

export type IpDecision = {
  allowed: boolean;
  /** When false: short explanation suitable for showing the user. */
  reason?: string;
};

export type EvaluateOptions = {
  tenantId: string;
  ip: string;
  /** Which auth surface invoked us — for the audit payload. */
  surface: "session" | "api-key";
  /** API key id when surface=api-key, for audit attribution. */
  apiKeyId?: string;
  /** Membership id of the session caller, when surface=session. */
  membershipId?: string;
};

const AUDIT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const denialAuditCache = new Map<string, number>();

function shouldAudit(tenantId: string, maskedIp: string): boolean {
  const key = `${tenantId}|${maskedIp}`;
  const last = denialAuditCache.get(key) ?? 0;
  const now = Date.now();
  if (now - last < AUDIT_THROTTLE_MS) return false;
  denialAuditCache.set(key, now);
  // Cap memory: drop the oldest half when we cross 5000 entries.
  if (denialAuditCache.size > 5000) {
    const entries = Array.from(denialAuditCache.entries()).sort((a, b) => a[1] - b[1]);
    const drop = entries.slice(0, Math.floor(entries.length / 2));
    for (const [k] of drop) denialAuditCache.delete(k);
  }
  return true;
}

export async function evaluateIpAllowlist(opts: EvaluateOptions): Promise<IpDecision> {
  let cidrs: string[];
  try {
    const tenant = await superDb.tenant.findUnique({
      where: { id: opts.tenantId },
      select: { allowedIpCidrs: true },
    });
    if (!tenant) return { allowed: false, reason: "tenant not found" };
    cidrs = tenant.allowedIpCidrs;
  } catch (err) {
    // Fail OPEN on DB read errors — same posture as the rate
    // limiter. An IP allowlist must never make the platform less
    // available than it would have been without one configured.
    reportError(err, { route: "ip-allowlist/evaluate", tenantId: opts.tenantId });
    return { allowed: true };
  }

  if (cidrs.length === 0) return { allowed: true };

  if (ipInAnyCidr(opts.ip, cidrs)) return { allowed: true };

  // Denied — audit once per (tenant, ip, hour).
  const masked = maskIp(opts.ip);
  if (shouldAudit(opts.tenantId, masked ?? "unknown")) {
    try {
      await writeAuditEvent({
        tenantId: opts.tenantId,
        eventType: "IP_ALLOWLIST_DENIED",
        actorMembershipId: opts.membershipId ?? null,
        subjectType: "Tenant",
        subjectId: opts.tenantId,
        payload: {
          maskedIp: masked,
          surface: opts.surface,
          apiKeyId: opts.apiKeyId ?? null,
          allowlistSize: cidrs.length,
        },
      });
    } catch (err) {
      reportError(err, { route: "ip-allowlist/audit", tenantId: opts.tenantId });
    }
  }

  return {
    allowed: false,
    reason: `IP ${masked ?? opts.ip} is not in this tenant's allowlist`,
  };
}

/**
 * Validate a list of CIDR strings from the admin form. Returns the
 * canonicalised list on success (host-bits zeroed, /32 + /128
 * appended for single addresses) or an array of error messages
 * suitable for display.
 *
 * Kept here (not in `cidr.ts`) because it depends on the audit/
 * tenant context implicitly — admin-form validation is "what the
 * admin will see"; the parser primitive is "does this string
 * parse".
 */
export type AllowlistValidationResult =
  | { ok: true; cidrs: string[] }
  | { ok: false; errors: string[] };

export function validateAllowlist(input: readonly string[]): AllowlistValidationResult {
  // De-dupe + filter blank lines, but preserve order so the admin
  // sees their input as they typed it.
  const seen = new Set<string>();
  const cleaned: string[] = [];
  const errors: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const canonical = canonicaliseCidr(trimmed);
    if (!canonical) {
      errors.push(`'${trimmed}' is not a valid CIDR or IP address`);
      continue;
    }
    cleaned.push(canonical);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, cidrs: cleaned };
}
