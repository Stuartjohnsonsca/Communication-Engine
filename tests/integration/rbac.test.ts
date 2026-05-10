/**
 * RBAC permission matrix.
 *
 * The matrix in `src/lib/rbac.ts` is the canonical answer to "who can do
 * what". Every route handler calls `requirePermission(role, action)` against
 * it. These assertions cover three properties:
 *
 *   1. Documented permissions resolve correctly per role.
 *   2. Unknown actions deny by default.
 *   3. `requirePermission` throws PermissionError for denied combinations
 *      and is a no-op for allowed ones.
 *
 * This is a pure-function suite — no DB. It still belongs in the
 * integration pass because RBAC drift is the kind of regression that
 * silently widens authorisation.
 */
import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import { hasPermission, requirePermission, PermissionError, PERMISSIONS } from "@/lib/rbac";

const ALL_ROLES: Role[] = [
  "FIRM_ADMIN",
  "FCT_MEMBER",
  "USER",
  "SALES_REVIEWER",
  "CURATOR",
  "ACUMON_ADMIN",
];

describe("RBAC", () => {
  it("FCG commit is restricted to FCT and FIRM_ADMIN", () => {
    expect(hasPermission("FCT_MEMBER", "fcg:commit")).toBe(true);
    expect(hasPermission("FIRM_ADMIN", "fcg:commit")).toBe(true);
    expect(hasPermission("USER", "fcg:commit")).toBe(false);
    expect(hasPermission("SALES_REVIEWER", "fcg:commit")).toBe(false);
    expect(hasPermission("CURATOR", "fcg:commit")).toBe(false);
  });

  it("billing read/manage is FIRM_ADMIN only", () => {
    expect(hasPermission("FIRM_ADMIN", "billing:read")).toBe(true);
    expect(hasPermission("FIRM_ADMIN", "billing:manage")).toBe(true);
    for (const r of ALL_ROLES.filter((r) => r !== "FIRM_ADMIN")) {
      expect(hasPermission(r, "billing:read")).toBe(false);
      expect(hasPermission(r, "billing:manage")).toBe(false);
    }
  });

  it("DSAR fulfill is FIRM_ADMIN only; FCT can read and write", () => {
    expect(hasPermission("FIRM_ADMIN", "dsar:fulfill")).toBe(true);
    expect(hasPermission("FCT_MEMBER", "dsar:fulfill")).toBe(false);
    expect(hasPermission("FCT_MEMBER", "dsar:read")).toBe(true);
    expect(hasPermission("FCT_MEMBER", "dsar:write")).toBe(true);
  });

  it("xcl:opt-in is FIRM_ADMIN only (controllership decision per §11.2)", () => {
    expect(hasPermission("FIRM_ADMIN", "xcl:opt-in")).toBe(true);
    for (const r of ALL_ROLES.filter((r) => r !== "FIRM_ADMIN")) {
      expect(hasPermission(r, "xcl:opt-in")).toBe(false);
    }
  });

  it("emergency FCG override is FIRM_ADMIN only", () => {
    expect(hasPermission("FIRM_ADMIN", "fcg:emergency")).toBe(true);
    expect(hasPermission("FCT_MEMBER", "fcg:emergency")).toBe(false);
  });

  it("members:read is FIRM_ADMIN + FCT only; members:write is FIRM_ADMIN only", () => {
    expect(hasPermission("FIRM_ADMIN", "members:read")).toBe(true);
    expect(hasPermission("FCT_MEMBER", "members:read")).toBe(true);
    expect(hasPermission("USER", "members:read")).toBe(false);
    expect(hasPermission("FIRM_ADMIN", "members:write")).toBe(true);
    expect(hasPermission("FCT_MEMBER", "members:write")).toBe(false);
  });

  it("public-read permissions (roadmap/risks/integrations/sla/switching) are universal-read", () => {
    const universal = [
      "roadmap:read",
      "risks:read",
      "integrations:read",
      "sla:read",
      "switching:read",
      "languages:read",
      "accessibility:read",
    ];
    for (const action of universal) {
      for (const role of ALL_ROLES) {
        expect(hasPermission(role, action)).toBe(true);
      }
    }
  });

  it("public-manage permissions are FIRM_ADMIN + ACUMON_ADMIN only", () => {
    const managed = [
      "roadmap:manage",
      "risks:manage",
      "integrations:manage",
      "sla:manage",
      "subprocessors:manage",
      "languages:manage",
      "accessibility:manage",
    ];
    for (const action of managed) {
      expect(hasPermission("FIRM_ADMIN", action)).toBe(true);
      expect(hasPermission("ACUMON_ADMIN", action)).toBe(true);
      for (const r of ALL_ROLES.filter((r) => r !== "FIRM_ADMIN" && r !== "ACUMON_ADMIN")) {
        expect(hasPermission(r, action)).toBe(false);
      }
    }
  });

  it("unknown actions deny by default", () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, "totally:bogus")).toBe(false);
    }
  });

  it("requirePermission throws PermissionError on denial and is a no-op on allow", () => {
    expect(() => requirePermission("USER", "billing:manage")).toThrow(PermissionError);
    expect(() => requirePermission(undefined, "fcg:read")).toThrow(PermissionError);
    expect(() => requirePermission("FIRM_ADMIN", "billing:manage")).not.toThrow();
  });

  it("PermissionError carries the action, role, and 403 status", () => {
    try {
      requirePermission("USER", "billing:manage");
      throw new Error("should not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionError);
      const pe = e as PermissionError;
      expect(pe.status).toBe(403);
      expect(pe.action).toBe("billing:manage");
      expect(pe.role).toBe("USER");
    }
  });

  it("matrix only references valid Role enum values (no typos)", () => {
    const valid = new Set<Role>(ALL_ROLES);
    for (const [action, roles] of Object.entries(PERMISSIONS)) {
      for (const r of roles) {
        expect(valid.has(r), `${action} references invalid role ${r}`).toBe(true);
      }
    }
  });
});
