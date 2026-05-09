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

  // Sales Identifier
  "opportunity:review":  ["SALES_REVIEWER", "FIRM_ADMIN"],

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
