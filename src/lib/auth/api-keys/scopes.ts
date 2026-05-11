import type { Role } from "@prisma/client";
import { hasPermission } from "@/lib/rbac";

/**
 * Canonical scope catalogue for API-key auth.
 *
 * Scopes are NOT the same set as the RBAC `Permission` strings in
 * `src/lib/rbac.ts` — they are the integrator-facing subset, plus a
 * grouping layer so a single scope can fan out to several internal
 * permissions where it makes sense for an integrator.
 *
 * Design rule (PRD §6.2 + `feedback_drafts_only_post_send_check.md`):
 *
 *   Compliance-grade mutations (FCG vote/commit, draft create, breach
 *   acknowledge, DSAR fulfil, tenant termination, billing close) are
 *   NEVER exposed as API-key scopes. Those acts must trace to a human
 *   Membership session for forensic accountability. API keys serve
 *   integrators and automation — reading data out, replaying webhooks
 *   that already fired, listing what's configured.
 *
 * Each scope maps to:
 *  - one or more underlying RBAC permission strings (`requires`), ALL
 *    of which the creator-Membership's role must hold for the scope to
 *    be assignable. Stripe-style: a key inherits the creator's
 *    permissions narrowed by the chosen scopes; it can never grant a
 *    scope its creator didn't already have.
 *  - a human description shown in the admin UI.
 *
 * The wildcard `"*"` is a sentinel — it bypasses the per-scope check
 * but still narrows to the creator-Membership's role on the request
 * path. So a FCT_MEMBER `"*"` key can read everything an FCT_MEMBER
 * could, not everything a FIRM_ADMIN could.
 */

export type ApiScope =
  | "audit:read"
  | "webhooks:read"
  | "webhooks:replay"
  | "webhooks:configure"
  | "members:read"
  | "adherence:read"
  | "sentiment:read"
  | "drafts:read"
  | "actions:read"
  | "meetings:read"
  | "opportunities:read"
  | "fcg:read"
  | "ucg:read"
  | "compliance:read";

export type ScopeDefinition = {
  scope: ApiScope;
  description: string;
  /** RBAC permission strings the creator-Membership must already hold. */
  requires: string[];
};

export const SCOPE_CATALOGUE: ScopeDefinition[] = [
  {
    scope: "audit:read",
    description: "Read the per-tenant audit chain. SIEM / archival use.",
    requires: ["audit:read"],
  },
  {
    scope: "webhooks:read",
    description: "List configured webhook subscriptions + delivery history.",
    requires: ["webhooks:read"],
  },
  {
    scope: "webhooks:replay",
    description: "Re-enqueue a dead-lettered webhook delivery.",
    requires: ["webhooks:configure"],
  },
  {
    scope: "webhooks:configure",
    description: "Create, update, or revoke webhook subscriptions.",
    requires: ["webhooks:configure"],
  },
  {
    scope: "members:read",
    description: "Read the tenant's Membership directory (id, role, status).",
    requires: ["members:read"],
  },
  {
    scope: "adherence:read",
    description: "Read CommunicationAdherence rows + escalations queue.",
    requires: ["adherence:read"],
  },
  {
    scope: "sentiment:read",
    description: "Read sentiment signals + escalations.",
    requires: ["fcg:read"],
  },
  {
    scope: "drafts:read",
    description: "Read drafts the caller's Membership could see in-app.",
    requires: ["draft:read:self"],
  },
  {
    scope: "actions:read",
    description: "Read actions the caller's Membership could see in-app.",
    requires: ["draft:read:self"],
  },
  {
    scope: "meetings:read",
    description: "Read meetings + papers (calendar surface, not transcripts).",
    requires: ["meeting:read"],
  },
  {
    scope: "opportunities:read",
    description: "Read sales-identifier opportunities queue.",
    requires: ["opportunity:review"],
  },
  {
    scope: "fcg:read",
    description: "Read the Firm Culture Guide + open proposals.",
    requires: ["fcg:read"],
  },
  {
    scope: "ucg:read",
    description: "Read the caller-Membership's own User Culture Guide.",
    requires: ["ucg:read:self"],
  },
  {
    scope: "compliance:read",
    description: "Read compliance posture (DPIA, TIA, breach notices, SLA, terms).",
    requires: ["dpia:read"],
  },
];

const SCOPE_LOOKUP: Map<string, ScopeDefinition> = new Map(
  SCOPE_CATALOGUE.map((s) => [s.scope, s]),
);

export function isWildcard(scopes: readonly string[]): boolean {
  return scopes.includes("*");
}

export function isKnownScope(scope: string): scope is ApiScope {
  return SCOPE_LOOKUP.has(scope);
}

export function scopeDefinition(scope: string): ScopeDefinition | null {
  return SCOPE_LOOKUP.get(scope) ?? null;
}

export class ScopeError extends Error {
  status = 403;
  constructor(public readonly scope: string, public readonly reason: string) {
    super(`API scope denied: ${scope} — ${reason}`);
    this.name = "ScopeError";
  }
}

/**
 * Verify a list of scopes is assignable by a Membership with the given
 * role. Throws on the first violation so the admin UI surfaces a clear
 * message ("scope X requires permission Y which your role doesn't
 * hold"). Wildcard is always assignable — the request path narrows it
 * to the underlying role on every call.
 */
export function assertAssignable(role: Role, scopes: readonly string[]): void {
  if (scopes.length === 0) {
    throw new ScopeError("(empty)", "at least one scope is required");
  }
  if (isWildcard(scopes) && scopes.length > 1) {
    throw new ScopeError("*", "wildcard is exclusive — do not combine with named scopes");
  }
  if (isWildcard(scopes)) return;
  for (const scope of scopes) {
    const def = scopeDefinition(scope);
    if (!def) throw new ScopeError(scope, "not a known scope");
    for (const required of def.requires) {
      if (!hasPermission(role, required)) {
        throw new ScopeError(scope, `creator role ${role} lacks underlying permission ${required}`);
      }
    }
  }
}

/**
 * Check whether an authenticated API-key request that carries the given
 * scope set can satisfy a required scope. The wildcard `*` matches any
 * required scope (still narrowed by role downstream). Also verifies
 * the underlying RBAC permissions still hold for the role — handles
 * the case where the creator's role was downgraded after issuance.
 */
export function scopeAllows(
  granted: readonly string[],
  role: Role,
  required: ApiScope,
): boolean {
  const def = scopeDefinition(required);
  if (!def) return false;
  // Wildcard: still must pass the underlying permission check against
  // the (possibly downgraded) current role.
  if (isWildcard(granted)) {
    return def.requires.every((p) => hasPermission(role, p));
  }
  if (!granted.includes(required)) return false;
  return def.requires.every((p) => hasPermission(role, p));
}
