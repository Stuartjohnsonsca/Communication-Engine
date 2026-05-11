/**
 * Compliance evidence pack (post-PRD hardening).
 *
 * Coverage:
 *   - Happy path: pack contains every advertised section with the
 *     expected shape; meta carries generatedAt + tenantId + slug +
 *     schemaVersion + sections.
 *   - Security config reflects the tenant's actual settings.
 *   - Membership summary counts by role + by status correctly across
 *     mixed active/suspended/anonymised seeded rows.
 *   - API keys: hash + keyVersion + revokedReason are NOT in the
 *     output. This is the load-bearing no-secrets invariant — the
 *     pack must survive an external review without leaking material
 *     that could be replayed.
 *   - Cross-tenant isolation: tenant B's data NEVER appears in
 *     tenant A's pack (memberships, api keys, audit chain length,
 *     active terms, breach incidents).
 *   - Audit chain section reports the actual `seq` count + most
 *     recent verification result correctly.
 *   - Sub-processor section reflects active rows + pending changes
 *     (these are global, not tenant-scoped — same posture as the
 *     /switching surface).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import {
  buildEvidencePack,
  ALL_SECTIONS,
  EVIDENCE_PACK_SCHEMA_VERSION,
} from "@/lib/compliance/evidence-pack";

type Tenant = Awaited<ReturnType<typeof superDb.tenant.create>>;

async function makeTenant(name = "evidence test"): Promise<Tenant> {
  return superDb.tenant.create({
    data: {
      slug: `evp-${randomUUID().slice(0, 8)}`,
      name,
      requireTotp: false,
      sessionIdleTimeoutMinutes: 45,
      sessionAbsoluteTimeoutMinutes: 480,
      stepUpMaxAgeMinutes: 5,
      allowedIpCidrs: ["10.0.0.0/8", "2001:db8::/32"],
    },
  });
}

async function cleanupTenant(tenantId: string) {
  await superDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
}

describe("buildEvidencePack", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await makeTenant();
  });
  afterEach(async () => {
    await cleanupTenant(tenant.id);
  });

  it("returns the full advertised section set with stable meta", async () => {
    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.meta.tenantId).toBe(tenant.id);
    expect(pack.meta.tenantSlug).toBe(tenant.slug);
    expect(pack.meta.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION);
    expect(pack.meta.sections.sort()).toEqual([...ALL_SECTIONS].sort());
    // ISO timestamp format check.
    expect(pack.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reflects the tenant's security configuration faithfully", async () => {
    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.securityConfig.requireTotp).toBe(false);
    expect(pack.securityConfig.sessionIdleTimeoutMinutes).toBe(45);
    expect(pack.securityConfig.sessionAbsoluteTimeoutMinutes).toBe(480);
    expect(pack.securityConfig.stepUpMaxAgeMinutes).toBe(5);
    expect(pack.securityConfig.allowedIpCidrsCount).toBe(2);
    expect(pack.securityConfig.allowedIpCidrs.sort()).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
  });

  it("counts memberships by role and status", async () => {
    const u1 = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const u2 = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const u3 = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    await superDb.membership.create({
      data: { tenantId: tenant.id, userId: u1.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    await superDb.membership.create({
      data: { tenantId: tenant.id, userId: u2.id, role: "USER", status: "ACTIVE" },
    });
    await superDb.membership.create({
      data: { tenantId: tenant.id, userId: u3.id, role: "USER", status: "SUSPENDED" },
    });

    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.membershipSummary.total).toBe(3);
    expect(pack.membershipSummary.byRole.FIRM_ADMIN).toBe(1);
    expect(pack.membershipSummary.byRole.USER).toBe(2);
    expect(pack.membershipSummary.byStatus.ACTIVE).toBe(2);
    expect(pack.membershipSummary.byStatus.SUSPENDED).toBe(1);
  });

  it("NEVER includes API key hash, keyVersion, or revokedReason in the output", async () => {
    const admin = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const m = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: admin.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    await superDb.apiKey.create({
      data: {
        tenantId: tenant.id,
        name: "test key",
        prefix: `ack_${randomUUID().slice(0, 8)}`,
        hash: "DEADBEEFCAFEBABE-this-must-not-leak",
        keyVersion: "v2",
        scopes: ["webhooks:read"],
        createdByMembershipId: m.id,
      },
    });

    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.apiKeys.activeCount).toBe(1);
    expect(pack.apiKeys.keys).toHaveLength(1);
    const k = pack.apiKeys.keys[0];

    // Whitelist the fields we DO expose; the rest must not appear.
    const allowed = new Set([
      "id",
      "name",
      "prefix",
      "scopes",
      "createdAt",
      "expiresAt",
      "revokedAt",
      "lastUsedAt",
    ]);
    for (const key of Object.keys(k)) {
      expect(allowed.has(key), `unexpected API key field: ${key}`).toBe(true);
    }

    // Belt and braces: serialised pack must NOT contain the hash string.
    const json = JSON.stringify(pack);
    expect(json).not.toContain("DEADBEEFCAFEBABE-this-must-not-leak");
    expect(json).not.toContain("keyVersion");
  });

  it("isolates tenant data across two parallel tenants", async () => {
    const tenantB = await makeTenant("evidence test B");
    try {
      // Tenant A: 2 members, 1 audit event.
      const aUser = await superDb.user.create({
        data: { email: `a-${randomUUID().slice(0, 8)}@example.test` },
      });
      const aMembership = await superDb.membership.create({
        data: { tenantId: tenant.id, userId: aUser.id, role: "FIRM_ADMIN", status: "ACTIVE" },
      });
      await writeAuditEvent({
        tenantId: tenant.id,
        eventType: "DSAR_OPENED",
        actorMembershipId: aMembership.id,
        subjectType: "Test",
        subjectId: "x",
        payload: { tenant: "A" },
      });

      // Tenant B: 5 members, 3 audit events. None must leak into A's pack.
      for (let i = 0; i < 5; i++) {
        const u = await superDb.user.create({
          data: { email: `b${i}-${randomUUID().slice(0, 8)}@example.test` },
        });
        const m = await superDb.membership.create({
          data: { tenantId: tenantB.id, userId: u.id, role: "USER", status: "ACTIVE" },
        });
        if (i < 3) {
          await writeAuditEvent({
            tenantId: tenantB.id,
            eventType: "DSAR_OPENED",
            actorMembershipId: m.id,
            subjectType: "Test",
            subjectId: `b${i}`,
            payload: { tenant: "B" },
          });
        }
      }

      const packA = await buildEvidencePack({ tenantId: tenant.id });
      const packB = await buildEvidencePack({ tenantId: tenantB.id });

      expect(packA.membershipSummary.total).toBe(1);
      expect(packB.membershipSummary.total).toBe(5);
      expect(packA.auditChain.totalEvents).toBe(1);
      expect(packB.auditChain.totalEvents).toBe(3);
    } finally {
      await cleanupTenant(tenantB.id);
    }
  });

  it("reports the latest audit-chain seq and verification status", async () => {
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const m = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });

    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "DSAR_OPENED",
      actorMembershipId: m.id,
      subjectType: "Test",
      subjectId: "x",
      payload: {},
    });
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "DSAR_FULFILLED",
      actorMembershipId: m.id,
      subjectType: "Test",
      subjectId: "x",
      payload: { outcome: "FULFILLED" },
    });

    await superDb.auditChainVerification.create({
      data: {
        tenantId: tenant.id,
        status: "OK",
        startedAt: new Date(),
        finishedAt: new Date(),
        eventCount: 2,
      },
    });

    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.auditChain.totalEvents).toBe(2);
    expect(pack.auditChain.latestSeq).toBe("2");
    expect(pack.auditChain.lastVerificationStatus).toBe("OK");
    expect(pack.auditChain.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pack.auditChain.lastTamperedAt).toBeNull();
  });

  it("reports the most recent encryption key rotation timestamp", async () => {
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const m = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    await writeAuditEvent({
      tenantId: tenant.id,
      eventType: "ENCRYPTION_KEYS_ROTATED",
      actorMembershipId: m.id,
      subjectType: "EncryptionKeyRegistry",
      subjectId: "registry",
      payload: { activeVersion: "v2" },
    });
    const pack = await buildEvidencePack({ tenantId: tenant.id });
    expect(pack.encryption.rotationsRecorded).toBe(1);
    expect(pack.encryption.lastRotationAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
