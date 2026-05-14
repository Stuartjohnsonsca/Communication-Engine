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

  it("rejects non-OAuth channel kind (e.g. IMANAGE / ZOOM in current registry)", async () => {
    // After item 103 wired TEAMS + SHAREPOINT, the canonical "no OAuth"
    // examples are IMANAGE, ZOOM, WHATSAPP_BUSINESS — kinds that have
    // `realOAuthAvailable: NEVER` and no `oauthAuthorizeUrl`.
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-noauth-kind"),
    });
    const oauthKinds = oauthCapableChannelKinds().map((k) => k.kind);
    expect(oauthKinds).not.toContain("IMANAGE");
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "IMANAGE",
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

describe("channel-oauth-apps — item 102 — M365 + additional config", () => {
  it("M365 round-trip: aadTenantId persists and is returned by the resolver", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-m365-rt"),
    });
    const aadTenantId = "11111111-2222-3333-4444-555555555555";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "M365",
      clientId: "m365-app-id",
      clientSecret: "m365-secret",
      additionalConfig: { aadTenantId },
      actorMembershipId: admin.membership.id,
    });
    const resolved = await getTenantOAuthApp(tenant.id, "M365");
    expect(resolved).not.toBeNull();
    expect(resolved!.clientId).toBe("m365-app-id");
    expect(resolved!.clientSecret).toBe("m365-secret");
    expect(resolved!.additionalConfig.aadTenantId).toBe(aadTenantId);
  });

  it("M365 OAuth URLs embed the per-tenant AAD authority", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("M365");
    const aadTenantId = "abcdef12-3456-7890-abcd-ef1234567890";
    const auth = m.oauthAuthorizeUrl!({ aadTenantId });
    const tok = m.oauthTokenUrl!({ aadTenantId });
    expect(auth).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`,
    );
    expect(tok).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/token`,
    );
  });

  it("M365 falls back to 'common' when no aadTenantId is configured", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("M365");
    delete process.env.M365_TENANT_ID; // ensure no env override
    const auth = m.oauthAuthorizeUrl!(null);
    expect(auth).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
  });

  it("M365 sanitises malformed aadTenantId (URL-injection defence)", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("M365");
    // Slashes, query strings, scheme bytes — all stripped by the
    // alphanumeric-and-dash whitelist.
    const malicious = "evil/path?leak=1#frag";
    const auth = m.oauthAuthorizeUrl!({ aadTenantId: malicious });
    // The result must NOT contain the slash / query / fragment.
    expect(auth).not.toContain("/path");
    expect(auth).not.toContain("?leak");
    expect(auth).not.toContain("#frag");
    // The remaining content is just the safe subset.
    expect(auth).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/[a-zA-Z0-9-]+\/oauth2\/v2\.0\/authorize$/,
    );
  });

  it("upsert drops unknown additionalConfig keys silently (defence in depth)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-unknown-key"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "M365",
      clientId: "id",
      clientSecret: "sec",
      additionalConfig: {
        aadTenantId: "valid-tenant-id",
        rogueKey: "should be dropped",
        anotherRogue: "also dropped",
      },
      actorMembershipId: admin.membership.id,
    });
    const resolved = await getTenantOAuthApp(tenant.id, "M365");
    expect(resolved!.additionalConfig).toEqual({
      aadTenantId: "valid-tenant-id",
    });
    expect(resolved!.additionalConfig.rogueKey).toBeUndefined();
  });

  it("upsert rejects oversized additionalConfig values (DoS defence)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-oversize"),
    });
    await expect(
      upsertTenantOAuthApp({
        tenantId: tenant.id,
        channelKind: "M365",
        clientId: "id",
        clientSecret: "sec",
        additionalConfig: { aadTenantId: "x".repeat(257) },
        actorMembershipId: admin.membership.id,
      }),
    ).rejects.toThrow(/256/);
  });

  it("Google upsert without additionalConfig still works (no schema, no required fields)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-google-no-extras"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "GOOGLE",
      clientId: "id",
      clientSecret: "sec",
      // No additionalConfig — Google has no extras schema.
      actorMembershipId: admin.membership.id,
    });
    const resolved = await getTenantOAuthApp(tenant.id, "GOOGLE");
    expect(resolved!.additionalConfig).toEqual({});
  });

  it("audit payload records additional-config keys + verbatim values (M365 aadTenantId is public-by-design)", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-audit-extras"),
    });
    const aadTenantId = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "M365",
      clientId: "id",
      clientSecret: "secret-must-not-leak-via-audit",
      additionalConfig: { aadTenantId },
      actorMembershipId: admin.membership.id,
    });
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, eventType: "CHANNEL_OAUTH_APP_CONFIGURED" },
    });
    const payload = audit!.payload as {
      additionalConfigKeys?: string[];
      additionalConfigFingerprints?: Record<string, string>;
    };
    expect(payload.additionalConfigKeys).toEqual(["aadTenantId"]);
    expect(payload.additionalConfigFingerprints?.aadTenantId).toBe(aadTenantId);
    // The secret must STILL never appear in the audit row.
    expect(JSON.stringify(audit)).not.toContain("secret-must-not-leak-via-audit");
  });

  it("oauthCapableChannelKinds surfaces additionalConfigSchema for the UI", async () => {
    const kinds = oauthCapableChannelKinds();
    const m365 = kinds.find((k) => k.kind === "M365");
    expect(m365).toBeDefined();
    expect(m365!.additionalConfigSchema).toHaveLength(1);
    expect(m365!.additionalConfigSchema[0].key).toBe("aadTenantId");
    const google = kinds.find((k) => k.kind === "GOOGLE");
    expect(google!.additionalConfigSchema).toHaveLength(0);
  });
});

describe("channel-oauth-apps — item 103 — TEAMS + SHAREPOINT", () => {
  it("oauthCapableChannelKinds includes TEAMS, SHAREPOINT, M365, GOOGLE, SLACK", () => {
    const kinds = oauthCapableChannelKinds().map((k) => k.kind).sort();
    expect(kinds).toContain("TEAMS");
    expect(kinds).toContain("SHAREPOINT");
    expect(kinds).toContain("M365");
    expect(kinds).toContain("GOOGLE");
    expect(kinds).toContain("SLACK");
  });

  it("TEAMS embeds the per-tenant AAD authority in both URLs", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("TEAMS");
    const aadTenantId = "aaaaaaaa-1111-2222-3333-444444444444";
    expect(m.oauthAuthorizeUrl!({ aadTenantId })).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`,
    );
    expect(m.oauthTokenUrl!({ aadTenantId })).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/token`,
    );
  });

  it("SHAREPOINT embeds the per-tenant AAD authority in both URLs", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("SHAREPOINT");
    const aadTenantId = "bbbbbbbb-1111-2222-3333-444444444444";
    expect(m.oauthAuthorizeUrl!({ aadTenantId })).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`,
    );
    expect(m.oauthTokenUrl!({ aadTenantId })).toBe(
      `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/token`,
    );
  });

  it("TEAMS scopes include offline_access (refresh tokens) + Teams-specific reads", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("TEAMS");
    expect(m.scopeDefault).toContain("offline_access");
    expect(m.scopeDefault).toContain("ChannelMessage.Read.All");
    expect(m.scopeDefault).toContain("Chat.Read");
  });

  it("SHAREPOINT scopes include offline_access (refresh tokens) + SharePoint-specific reads", async () => {
    const { meta } = await import("@/lib/channels/registry");
    const m = meta("SHAREPOINT");
    expect(m.scopeDefault).toContain("offline_access");
    expect(m.scopeDefault).toContain("Sites.Read.All");
    expect(m.scopeDefault).toContain("Files.Read.All");
  });

  it("TEAMS round-trip: per-tenant clientId/secret/aadTenantId persist independently of M365", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-teams-rt"),
    });
    const aadTenantId = "cccccccc-1111-2222-3333-444444444444";
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "TEAMS",
      clientId: "teams-app-id",
      clientSecret: "teams-secret",
      additionalConfig: { aadTenantId },
      actorMembershipId: admin.membership.id,
    });
    // M365 also configured for the same tenant — must not collide.
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "M365",
      clientId: "m365-app-id",
      clientSecret: "m365-secret",
      additionalConfig: { aadTenantId: "different-aad-tenant" },
      actorMembershipId: admin.membership.id,
    });
    const teams = await getTenantOAuthApp(tenant.id, "TEAMS");
    const m365 = await getTenantOAuthApp(tenant.id, "M365");
    expect(teams!.clientId).toBe("teams-app-id");
    expect(teams!.clientSecret).toBe("teams-secret");
    expect(teams!.additionalConfig.aadTenantId).toBe(aadTenantId);
    expect(m365!.clientId).toBe("m365-app-id");
    expect(m365!.additionalConfig.aadTenantId).toBe("different-aad-tenant");
  });

  it("SHAREPOINT additionalConfig accepts aadTenantId via the same schema as M365 / TEAMS", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("oauth-sp-rt"),
    });
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "SHAREPOINT",
      clientId: "sp-app-id",
      clientSecret: "sp-secret",
      additionalConfig: { aadTenantId: "dddddddd-1111-2222-3333-444444444444" },
      actorMembershipId: admin.membership.id,
    });
    const sp = await getTenantOAuthApp(tenant.id, "SHAREPOINT");
    expect(sp!.additionalConfig.aadTenantId).toBe(
      "dddddddd-1111-2222-3333-444444444444",
    );
    // Unknown extras for SHAREPOINT are still dropped.
    await upsertTenantOAuthApp({
      tenantId: tenant.id,
      channelKind: "SHAREPOINT",
      clientId: "sp-app-id",
      clientSecret: "sp-secret",
      additionalConfig: { aadTenantId: "x", junk: "ignored" },
      actorMembershipId: admin.membership.id,
    });
    const sp2 = await getTenantOAuthApp(tenant.id, "SHAREPOINT");
    expect(sp2!.additionalConfig).toEqual({ aadTenantId: "x" });
  });
});
