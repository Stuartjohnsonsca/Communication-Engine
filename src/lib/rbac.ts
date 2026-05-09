import type { Role } from "@prisma/client";

/**
 * Permission matrix per PRD §4. `*` = all roles.
 * Format: `{resource}:{action}`.
 */
export const PERMISSIONS: Record<string, Role[]> = {
  // FCG
  "fcg:read":            ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER"],
  "fcg:propose":         ["FIRM_ADMIN", "FCT_MEMBER", "USER"],
  "fcg:vote":            ["FCT_MEMBER", "FIRM_ADMIN"],
  "fcg:commit":          ["FCT_MEMBER", "FIRM_ADMIN"],
  "fcg:emergency":       ["FIRM_ADMIN"],

  // UCG
  "ucg:read:self":       ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "ucg:read:any":        ["FCT_MEMBER", "FIRM_ADMIN"],
  "ucg:write:self":      ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "ucg:override":        ["FCT_MEMBER", "FIRM_ADMIN"],

  // Drafting
  "draft:read:self":     ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "draft:create":        ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],

  // Meetings (PRD §7.4) — any User can schedule a meeting they are running
  // and draft its paper. The paper-author defaults to the meeting creator
  // unless an FCT/admin reassigns it.
  "meeting:create":      ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "meeting:write":       ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],
  "meeting:read":        ["USER", "FCT_MEMBER", "FIRM_ADMIN", "SALES_REVIEWER"],

  // Admin
  "members:read":        ["FIRM_ADMIN", "FCT_MEMBER"],
  "members:write":       ["FIRM_ADMIN"],
  "channels:write":      ["FIRM_ADMIN"],
  "audit:read":          ["FIRM_ADMIN", "FCT_MEMBER"],
  "audit:export":        ["FIRM_ADMIN"],

  // DPIA Helper (PRD §12.2). FCT can see attestation status; only the Firm
  // Administrator (in tandem with the Client DPO offline) can sign one off.
  "dpia:read":           ["FIRM_ADMIN", "FCT_MEMBER"],
  "dpia:write":          ["FIRM_ADMIN"],

  // DSAR module (PRD §12.4). FCT can see and progress requests; only the
  // Firm Administrator can mark a DSAR fulfilled (tight to the Client's
  // statutory accountability). Subjects download their own data via the
  // standard ACCESS export, not via a separate role.
  "dsar:read":           ["FIRM_ADMIN", "FCT_MEMBER"],
  "dsar:write":          ["FIRM_ADMIN", "FCT_MEMBER"],
  "dsar:fulfill":        ["FIRM_ADMIN"],

  // Sales Identifier
  "opportunity:review":  ["SALES_REVIEWER", "FIRM_ADMIN"],

  // User Lifecycle (PRD §14.3). FCT can see the lifecycle console (the FCT
  // is notified on revocation and tracks anonymisation timing); only the
  // Firm Administrator can mark a member as leaver or reverse it. Self-serve
  // revocation lives outside the role gate — any member can revoke their
  // own access from /account.
  "lifecycle:read":      ["FIRM_ADMIN", "FCT_MEMBER"],
  "lifecycle:write":     ["FIRM_ADMIN"],

  // Billing (PRD §15). Commercial concern — kept to the Firm Administrator
  // alone. The FCT does not see invoices or pricing.
  "billing:read":        ["FIRM_ADMIN"],
  "billing:manage":      ["FIRM_ADMIN"],

  // Roadmap (PRD §16). The product roadmap is published to every Client per
  // §15.3 switching/lock-in posture, so any signed-in role can read. Mutating
  // status / exit criteria is operator-only and additionally gated to the
  // Acumon-internal tenant in the page handler — there's no concept of a
  // per-Client roadmap, only one product plan.
  "roadmap:read":        ["FIRM_ADMIN", "FCT_MEMBER", "USER", "SALES_REVIEWER", "CURATOR", "ACUMON_ADMIN"],
  "roadmap:manage":      ["FIRM_ADMIN", "ACUMON_ADMIN"],

  // Acumon side
  "xcl:curate":          ["CURATOR", "ACUMON_ADMIN"],
  "tenant:provision":    ["ACUMON_ADMIN"],
};

export function hasPermission(role: Role, action: string): boolean {
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(role);
}

export function requirePermission(role: Role | undefined, action: string): asserts role is Role {
  if (!role || !hasPermission(role, action)) {
    throw new PermissionError(action, role);
  }
}

export class PermissionError extends Error {
  status = 403;
  constructor(public action: string, public role?: Role) {
    super(`Permission denied: role=${role ?? "anon"} cannot ${action}`);
    this.name = "PermissionError";
  }
}
