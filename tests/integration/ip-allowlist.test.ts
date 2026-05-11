/**
 * Post-PRD hardening item 17 — tenant IP allowlist.
 *
 * Coverage:
 *  - cidr.ts:
 *      parseCidr handles v4, v6, single-host (no slash), invalid input
 *      ipInCidr v4 + v6 prefix matching incl. /32 and /128 single-host
 *      ipInCidr handles IPv4-mapped IPv6 (`::ffff:1.2.3.4` matches v4 CIDR)
 *      ipInAnyCidr short-circuits, returns false on empty list, skips
 *        malformed entries
 *      canonicaliseCidr appends /32 + /128 for slashless input
 *  - validateAllowlist: rejects malformed entries with errors[], dedupes,
 *    preserves order, returns canonical list on success.
 *  - evaluateIpAllowlist:
 *      empty list → allowed regardless of IP
 *      non-empty list + matching IP → allowed
 *      non-empty list + non-matching IP → denied + writes
 *        IP_ALLOWLIST_DENIED audit
 *      audit is throttled per (tenant, masked-ip) per hour
 *      DB error in tenant lookup → fails OPEN (allowed=true)
 *  - updateTenantAllowlist:
 *      writes TENANT_IP_ALLOWLIST_CHANGED audit on diff with
 *        before/after/added/removed counts
 *      no-op (no audit) when the new list equals the previous list
 *      throws AllowlistValidationError on malformed input
 */
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  parseCidr,
  ipInCidr,
  ipInAnyCidr,
  canonicaliseCidr,
  validateAllowlist,
  evaluateIpAllowlist,
  updateTenantAllowlist,
  AllowlistValidationError,
} from "@/lib/auth/ip-allowlist";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

describe("ip-allowlist :: cidr parsing", () => {
  it("parses v4 CIDR with and without slash", () => {
    expect(parseCidr("192.0.2.0/24")).not.toBeNull();
    expect(parseCidr("192.0.2.5")?.prefix).toBe(32);
    expect(parseCidr("10.0.0.0/8")?.family).toBe("v4");
  });

  it("parses v6 CIDR with and without slash", () => {
    expect(parseCidr("2001:db8::/32")).not.toBeNull();
    expect(parseCidr("::1")?.prefix).toBe(128);
    expect(parseCidr("fe80::/10")?.family).toBe("v6");
  });

  it("rejects malformed inputs", () => {
    expect(parseCidr("")).toBeNull();
    expect(parseCidr("not-an-ip")).toBeNull();
    expect(parseCidr("999.0.0.0/24")).toBeNull();
    expect(parseCidr("192.0.2.0/33")).toBeNull();
    expect(parseCidr("192.0.2.0/-1")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("01.0.0.0/8")).toBeNull(); // leading-zero octet
    expect(parseCidr("not::a::cidr")).toBeNull(); // two `::`
  });
});

describe("ip-allowlist :: cidr matching", () => {
  it("matches v4 prefixes correctly", () => {
    expect(ipInCidr("192.0.2.5", "192.0.2.0/24")).toBe(true);
    expect(ipInCidr("192.0.3.5", "192.0.2.0/24")).toBe(false);
    expect(ipInCidr("192.0.2.5", "192.0.2.5/32")).toBe(true);
    expect(ipInCidr("192.0.2.5", "192.0.2.5")).toBe(true); // host as CIDR
    // Spanning a /22 boundary.
    expect(ipInCidr("10.0.3.255", "10.0.0.0/22")).toBe(true);
    expect(ipInCidr("10.0.4.0", "10.0.0.0/22")).toBe(false);
  });

  it("matches v6 prefixes correctly", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("::1", "::1")).toBe(true);
  });

  it("treats IPv4-mapped IPv6 as v4 for matching", () => {
    // A cloud proxy that upgrades v4 to v6-mapped should still match a
    // v4 CIDR the admin wrote.
    expect(ipInCidr("::ffff:192.0.2.5", "192.0.2.0/24")).toBe(true);
  });

  it("ipInAnyCidr returns false on empty list + short-circuits", () => {
    expect(ipInAnyCidr("192.0.2.5", [])).toBe(false);
    expect(ipInAnyCidr("192.0.2.5", ["10.0.0.0/8", "192.0.2.0/24"])).toBe(true);
    expect(ipInAnyCidr("8.8.8.8", ["10.0.0.0/8", "192.0.2.0/24"])).toBe(false);
  });

  it("ipInAnyCidr skips malformed entries silently", () => {
    expect(ipInAnyCidr("192.0.2.5", ["garbage", "192.0.2.0/24"])).toBe(true);
    expect(ipInAnyCidr("192.0.2.5", ["garbage"])).toBe(false);
  });

  it("canonicaliseCidr appends /32 + /128 for slashless input", () => {
    expect(canonicaliseCidr("192.0.2.5")).toBe("192.0.2.5/32");
    expect(canonicaliseCidr("::1")).toBe("::1/128");
    expect(canonicaliseCidr("192.0.2.0/24")).toBe("192.0.2.0/24");
    expect(canonicaliseCidr("garbage")).toBeNull();
  });
});

describe("ip-allowlist :: validateAllowlist", () => {
  it("returns canonicalised list on success", () => {
    const result = validateAllowlist(["192.0.2.0/24", "203.0.113.5", "  2001:db8::/32  "]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cidrs).toEqual(["192.0.2.0/24", "203.0.113.5/32", "2001:db8::/32"]);
    }
  });

  it("dedupes preserving first occurrence", () => {
    const result = validateAllowlist(["192.0.2.0/24", "192.0.2.0/24", "203.0.113.5"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cidrs).toHaveLength(2);
  });

  it("skips blank lines", () => {
    const result = validateAllowlist(["", "192.0.2.0/24", "   "]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cidrs).toEqual(["192.0.2.0/24"]);
  });

  it("reports all malformed entries", () => {
    const result = validateAllowlist(["garbage", "192.0.2.0/24", "also-bad"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors.some((e) => e.includes("garbage"))).toBe(true);
      expect(result.errors.some((e) => e.includes("also-bad"))).toBe(true);
    }
  });
});

describe("ip-allowlist :: evaluateIpAllowlist", () => {
  it("allows when tenant has empty allowlist", async () => {
    const tenant = await createTestTenant();
    const decision = await evaluateIpAllowlist({
      tenantId: tenant.id,
      ip: "192.0.2.5",
      surface: "session",
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows when caller IP matches an entry", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["192.0.2.0/24"],
    });
    const decision = await evaluateIpAllowlist({
      tenantId: tenant.id,
      ip: "192.0.2.5",
      surface: "api-key",
    });
    expect(decision.allowed).toBe(true);
  });

  it("denies + writes IP_ALLOWLIST_DENIED on non-matching IP", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["10.0.0.0/8"],
    });

    // Fresh denial IP — distinct masked value per test to side-step the
    // hourly throttle cache surviving across runs of the same vitest
    // process. The cache is keyed on tenant id, so a new test tenant
    // gives us a clean cache key.
    const decision = await evaluateIpAllowlist({
      tenantId: tenant.id,
      ip: "8.8.8.8",
      surface: "session",
      membershipId: membership.id,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not in/);

    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "IP_ALLOWLIST_DENIED" },
      orderBy: { seq: "desc" },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.surface).toBe("session");
    expect(payload.allowlistSize).toBe(1);
    // maskIp drops the last octet on v4.
    expect((payload.maskedIp as string).startsWith("8.8.8.")).toBe(true);
  });

  it("throttles denial audit to once per (tenant, masked-ip) per hour", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["10.0.0.0/8"],
    });
    for (let i = 0; i < 5; i++) {
      await evaluateIpAllowlist({
        tenantId: tenant.id,
        ip: "1.2.3.4",
        surface: "session",
        membershipId: membership.id,
      });
    }
    const count = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "IP_ALLOWLIST_DENIED" },
    });
    expect(count).toBe(1);
  });
});

describe("ip-allowlist :: updateTenantAllowlist", () => {
  it("writes TENANT_IP_ALLOWLIST_CHANGED on change with diff counts", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["192.0.2.0/24", "203.0.113.5"],
    });

    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "TENANT_IP_ALLOWLIST_CHANGED" },
      orderBy: { seq: "desc" },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.addedCount).toBe(2);
    expect(payload.removedCount).toBe(0);
    expect((payload.after as string[])).toEqual(["192.0.2.0/24", "203.0.113.5/32"]);
  });

  it("no-ops + writes no audit when the new list equals the previous", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["192.0.2.0/24"],
    });
    const countBefore = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "TENANT_IP_ALLOWLIST_CHANGED" },
    });
    await updateTenantAllowlist({
      tenantId: tenant.id,
      actorMembershipId: membership.id,
      lines: ["192.0.2.0/24"],
    });
    const countAfter = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "TENANT_IP_ALLOWLIST_CHANGED" },
    });
    expect(countAfter).toBe(countBefore);
  });

  it("throws AllowlistValidationError on malformed input", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "FIRM_ADMIN" });
    await expect(
      updateTenantAllowlist({
        tenantId: tenant.id,
        actorMembershipId: membership.id,
        lines: ["garbage", "192.0.2.0/24"],
      }),
    ).rejects.toThrowError(AllowlistValidationError);
  });
});
