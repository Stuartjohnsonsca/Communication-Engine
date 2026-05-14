/**
 * Post-PRD hardening item 101 — bring-your-own OAuth app per tenant
 * per channel kind.
 *
 * Coverage:
 *   - upsert + get round-trip: secret encrypts at rest, decrypts on
 *     read, returns plaintext to the resolver.
 *   - tenant isolation: tenant A's app does NOT leak into tenant B's
 *     resolver.
 *   - update path: changing the secret writes a new encrypted blob;
 *     old plaintext can no longer be recovered.
 *   - delete path: row gone, audit row written.
 *   - validation: empty clientId, empty secret, unknown channelKind,
 *     non-OAuth channelKind (e.g. TEAMS in current registry) all
 *     rejected.
 *   - audit invariant: payloads never carry the plaintext secret;
 *     only the last-4 fingerprint of the clientId.
 *   - secret rotation flag: payload `secretRotated` reflects whether
 *     the stored secret actually changed (vs clientId-only edit).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  getTenantOAuthApp,
  upsertTenantOAuthApp,
  deleteTenantOAuthApp,
  listTenantOAuthApps,
  oauthCapableChannelKinds,
} from "@/lib/channels/oauth-apps";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

const ENC_KEY =
  process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENC_KEY;
});

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("channel-oauth-apps — round-trip + isolation", () => {
  it("upsert + get returns the plaintext secret a resolver would use", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-rt"),
    });
    const clientId = "google-client-12345.apps.googleusercontent.com";
    const clientSecret = "GOCSPX-abc-secret";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId,
      clientSecret,
      actorMembershipId: admin.membership.id,
    });
    const resolved = await getTenantOAuthApp(tenant.id, "GOOGLE");
    expect(resolved).not.toBeNull();
    expect(resolved!.clientId).toBe(clientId);
    expect(resolved!.clientSecret).toBe(clientSecret);
  });

  it("the encrypted column is NOT the plaintext secret", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-enc"),
    });
    const clientSecret = "very-secret-VALUE-that-must-not-appear-on-disk";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id",
      clientSecret,
      actorMembershipId: admin.membership.id,
    });
    const row = await superDb.channelOAuthApp.findUnique({
      where: { tenantId_channelKind: { tenantId: tenant.id, channelKind: "GOOGLE" } },
    });
    expect(row).not.toBeNull();
    // Ciphertext blob must not contain the plaintext substring anywhere.
    expect(row!.clientSecretEncrypted).not.toContain(clientSecret);
  });

  it("tenant isolation: another tenant's app is invisible to my resolver", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const adminA = await createTestUserAndMembership(tenantA.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-iso-a"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenantA.id,
      channelKind: "GOOGLE",
      clientId: "tenant-a-client",
      clientSecret: "tenant-a-secret",
      actorMembershipId: adminA.membership.id,
    });
    const fromB = await getTenantOAuthApp(tenantB.id, "GOOGLE");
    expect(fromB).toBeNull();
    const fromA = await getTenantOAuthApp(tenantA.id, "GOOGLE");
    expect(fromA?.clientId).toBe("tenant-a-client");
  });
});

describe("channel-oauth-apps — update + delete", () => {
  it("update path: secret rotation reflected in audit; new plaintext returned by resolver", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-rot"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id1",
      clientSecret: "secret1",
      actorMembershipId: admin.membership.id,
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id1",
      clientSecret: "secret2",
      actorMembershipId: admin.membership.id,
    });
    const resolved = await getTenantOAuthApp(tenant.id, "GOOGLE");
    expect(resolved!.clientSecret).toBe("secret2");

    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_OAUTH_APP_CONFIGURED",
      },
      orderBy: { seq: "asc" },
    });
    expect(audits).toHaveLength(2);
    const second = audits[1].payload as {
      secretRotated?: boolean;
      isCreate?: boolean;
    };
    expect(second.secretRotated).toBe(true);
    expect(second.isCreate).toBe(false);
  });

  it("update with same secret reports secretRotated=false", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-norot"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id1",
      clientSecret: "samesecret",
      actorMembershipId: admin.membership.id,
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id2", // changed clientId, same secret
      clientSecret: "samesecret",
      actorMembershipId: admin.membership.id,
    });
    const audits = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "CHANNEL_OAUTH_APP_CONFIGURED",
      },
      orderBy: { seq: "asc" },
    });
    const second = audits[1].payload as { secretRotated?: boolean };
    expect(second.secretRotated).toBe(false);
  });

  it("delete: row gone, audit written, resolver returns null", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-del"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id",
      clientSecret: "secret",
      actorMembershipId: admin.membership.id,
    });
    const r = await deleteTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      actorMembershipId: admin.membership.id,
    });
    expect(r.deleted).toBe(true);
    const after = await getTenantOAuthApp(tenant.id, "GOOGLE");
    expect(after).toBeNull();
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "CHANNEL_OAUTH_APP_DELETED" },
    });
    expect(audit).not.toBeNull();
  });

  it("delete is idempotent on missing row (no audit, no error)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-idem-del"),
    });
    const r = await deleteTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      actorMembershipId: admin.membership.id,
    });
    expect(r.deleted).toBe(false);
    const audits = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "CHANNEL_OAUTH_APP_DELETED" },
    });
    expect(audits).toBe(0);
  });
});

describe("channel-oauth-apps — validation + audit-payload safety", () => {
  it("rejects empty clientId", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-empty-id"),
    });
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "GOOGLE",
        clientId: "   ",
        clientSecret: "x",
        actorMembershipId: admin.membership.id,
      }),
    ).rejects.toThrow(/clientId/i);
  });

  it("rejects empty clientSecret (use Delete to revert)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-empty-sec"),
    });
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "GOOGLE",
        clientId: "x",
        clientSecret: "",
        actorMembershipId: admin.membership.id,
      }),
    ).rejects.toThrow(/clientSecret/i);
  });

  it("rejects unknown channelKind", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-bad-kind"),
    });
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "NOT_A_KIND",
        clientId: "x",
        clientSecret: "y",
        actorMembershipId: admin.membership.id,
      }),
    ).rejects.toThrow(/does not support OAuth/i);
  });

  it("rejects non-OAuth channel kind (e.g. TEAMS in current registry)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-noauth-kind"),
    });
    // Verify TEAMS is indeed not in the OAuth-capable list (otherwise
    // this test silently no-ops).
    const oauthKinds = oauthCapableChannelKinds().map((k) => k.kind);
    expect(oauthKinds).not.toContain("TEAMS");
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "TEAMS",
        clientId: "x",
        clientSecret: "y",
        actorMembershipId: admin.membership.id,
      }),
    ).rejects.toThrow(/does not support OAuth/i);
  });

  it("audit payload never contains the plaintext secret; only last-4 of clientId", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-audit-safe"),
    });
    const veryRevealingSecret = "GOCSPX-PLAINTEXT-MUST-NEVER-LEAK";
    const fullClientId = "long-google-client-id-FULL.apps.googleusercontent.com";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: fullClientId,
      clientSecret: veryRevealingSecret,
      actorMembershipId: admin.membership.id,
    });
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "CHANNEL_OAUTH_APP_CONFIGURED" },
    });
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(veryRevealingSecret);
    expect(serialised).not.toContain(fullClientId); // full clientId also excluded — only last-4
    const payload = audit!.payload as { clientIdLast4?: string };
    expect(payload.clientIdLast4).toContain("…"); // last-4 prefix marker
    expect(payload.clientIdLast4!.endsWith(fullClientId.slice(-4))).toBe(true);
  });

  it("listTenantOAuthApps never decrypts the secret", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-list"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "google-id",
      clientSecret: "google-secret",
      actorMembershipId: admin.membership.id,
    });
    const list = await listTenantOAuthApps(tenant.id);
    expect(list).toHaveLength(1);
    expect(list[0].channelKind).toBe("GOOGLE");
    expect(list[0].clientIdLast4).toMatch(/…[a-zA-Z0-9-]{4}$/);
    // Listed shape has no clientSecret field by construction; assert the
    // serialised form doesn't carry it.
    expect(JSON.stringify(list)).not.toContain("google-secret");
  });
});
