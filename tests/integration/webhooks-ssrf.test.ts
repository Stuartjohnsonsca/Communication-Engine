/**
 * Webhook SSRF defence (post-PRD hardening).
 *
 * Coverage:
 *   - isPrivateIpv4: every documented private/loopback/link-local CIDR
 *     resolves to true; representative public IPs resolve to false; bad
 *     input (leading zero octets, non-numeric, wrong octet count) does
 *     not throw and falls back to false.
 *   - isPrivateIpv6: loopback ::1, unspecified ::, link-local fe80::/10,
 *     unique-local fc00::/7, multicast ff00::/8, IPv4-mapped private,
 *     IPv4-mapped public, public 2001:db8::; bad input does not throw.
 *   - isPrivateIp dispatches on `:` so callers don't have to.
 *   - isBlockedHostname: localhost, *.localhost, *.local, *.internal,
 *     bracketed v6 literal, bare IP literal, cloud-metadata DNS names;
 *     public hostnames pass through.
 *   - assertEgressAllowed: allowed for a hostname that resolves to a
 *     public IP; refused on blocked hostname (no DNS call); refused on
 *     resolved-private IP (DNS rebinding scenario); refused on DNS
 *     failure.
 *   - readBodyWithCap: truncates a body that exceeds the cap and sets
 *     `truncated:true`; preserves a body smaller than the cap with
 *     `truncated:false`; handles an empty body (no `res.body` stream).
 *   - validateUrl: rejects the new categories (`.local`, `.internal`,
 *     metadata.google.internal, v6 ULA, IPv4-mapped private) when run
 *     in production-mode; dev mode preserves the integration-test
 *     loopback exemption (NODE_ENV stays "test" in this suite — so we
 *     temporarily flip it via vi.stubEnv to verify the prod path).
 *   - runWebhookDeliveryBatch end-to-end: a delivery whose hostname
 *     resolves to a private IP via the injected `lookupImpl` is NOT
 *     fetched, the row enters retry with the SSRF reason recorded as
 *     `lastError`, and after maxAttempts is dead-lettered.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { superDb } from "@/lib/db";
import {
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  isBlockedHostname,
  assertEgressAllowed,
  readBodyWithCap,
} from "@/lib/webhooks/ssrf";
import {
  createSubscription,
  runWebhookDeliveryBatch,
  validateUrl,
  WebhookValidationError,
  enqueueWebhooks,
  type WebhookPayload,
} from "@/lib/webhooks";

describe("ssrf/isPrivateIpv4", () => {
  it("returns true for every documented private/loopback CIDR", () => {
    const privates = [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.169.254", // AWS metadata
      "172.16.0.1",
      "172.31.255.254",
      "192.0.0.1",
      "192.0.2.1", // TEST-NET-1
      "192.168.0.1",
      "192.168.255.255",
      "198.18.0.1", // benchmark
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast (in 240/4)
    ];
    for (const p of privates) {
      expect(isPrivateIpv4(p), `expected ${p} to be private`).toBe(true);
    }
  });

  it("returns false for representative public IPs", () => {
    const publics = ["1.1.1.1", "8.8.8.8", "13.32.0.1", "151.101.0.1", "104.16.0.1"];
    for (const p of publics) {
      expect(isPrivateIpv4(p), `expected ${p} to be public`).toBe(false);
    }
  });

  it("returns false (does not throw) on malformed input", () => {
    expect(isPrivateIpv4("")).toBe(false);
    expect(isPrivateIpv4("not.an.ip")).toBe(false);
    expect(isPrivateIpv4("1.2.3")).toBe(false);
    expect(isPrivateIpv4("1.2.3.4.5")).toBe(false);
    expect(isPrivateIpv4("256.0.0.1")).toBe(false);
    // Leading-zero octets are ambiguous — treat as malformed.
    expect(isPrivateIpv4("010.0.0.1")).toBe(false);
  });
});

describe("ssrf/isPrivateIpv6", () => {
  it("flags loopback / unspecified / link-local / ULA / multicast", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
    expect(isPrivateIpv6("::")).toBe(true);
    expect(isPrivateIpv6("fe80::1")).toBe(true);
    expect(isPrivateIpv6("fe80::abcd:1234")).toBe(true);
    expect(isPrivateIpv6("fc00::1")).toBe(true);
    expect(isPrivateIpv6("fd00::1")).toBe(true);
    expect(isPrivateIpv6("ff02::1")).toBe(true);
    expect(isPrivateIpv6("ff00::abcd")).toBe(true);
  });

  it("flags IPv4-mapped private addresses", () => {
    expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIpv6("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateIpv6("::ffff:169.254.169.254")).toBe(true);
  });

  it("does not flag IPv4-mapped public addresses or routable v6", () => {
    expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIpv6("2001:db8::1")).toBe(false);
    expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
  });

  it("returns false on malformed input", () => {
    expect(isPrivateIpv6("not::an::ip")).toBe(false);
    expect(isPrivateIpv6("gggg::1")).toBe(false);
    expect(isPrivateIpv6("12345::1")).toBe(false);
    expect(isPrivateIpv6("")).toBe(false);
  });

  it("strips zone id before checking link-local", () => {
    expect(isPrivateIpv6("fe80::1%eth0")).toBe(true);
  });
});

describe("ssrf/isPrivateIp dispatch", () => {
  it("dispatches to v4 vs v6 based on `:`", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2001:db8::1")).toBe(false);
  });
});

describe("ssrf/isBlockedHostname", () => {
  it("blocks loopback + intranet + metadata literals", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("My.Localhost")).toBe(true); // case-insensitive + suffix
    expect(isBlockedHostname("printer.local")).toBe(true);
    expect(isBlockedHostname("svc.cluster.internal")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("metadata")).toBe(true);
    expect(isBlockedHostname("ip6-localhost")).toBe(true);
  });

  it("blocks bare IP literals in hostname position", () => {
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.0.0.1")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isBlockedHostname("[::1]")).toBe(true);
    expect(isBlockedHostname("[fe80::1]")).toBe(true);
  });

  it("allows ordinary public hostnames", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("hooks.example.com")).toBe(false);
    expect(isBlockedHostname("api.acumon.com")).toBe(false);
    expect(isBlockedHostname("8.8.8.8")).toBe(false);
  });

  it("treats empty/whitespace hostnames as blocked", () => {
    expect(isBlockedHostname("")).toBe(true);
    expect(isBlockedHostname("   ")).toBe(true);
  });
});

describe("ssrf/assertEgressAllowed", () => {
  it("allows a hostname that resolves to a public IP", async () => {
    const out = await assertEgressAllowed("example.com", {
      lookup: async () => ({ address: "93.184.216.34", family: 4 }),
    });
    expect(out.allowed).toBe(true);
    if (out.allowed) expect(out.resolvedIp).toBe("93.184.216.34");
  });

  it("refuses a blocked hostname without ever calling DNS", async () => {
    let called = false;
    const out = await assertEgressAllowed("metadata.google.internal", {
      lookup: async () => {
        called = true;
        return { address: "1.2.3.4", family: 4 };
      },
    });
    expect(out.allowed).toBe(false);
    expect(called).toBe(false);
    if (!out.allowed) expect(out.reason).toMatch(/hostname/i);
  });

  it("refuses when DNS resolves to a private IP (rebinding case)", async () => {
    const out = await assertEgressAllowed("evil.example", {
      lookup: async () => ({ address: "169.254.169.254", family: 4 }),
    });
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toMatch(/169\.254\.169\.254/);
  });

  it("refuses when DNS resolution throws", async () => {
    const out = await assertEgressAllowed("nonexistent.example", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toMatch(/dns lookup failed/i);
  });

  it("refuses a hostname that resolves to a private v6 address", async () => {
    const out = await assertEgressAllowed("evil6.example", {
      lookup: async () => ({ address: "fc00::1", family: 6 }),
    });
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toMatch(/fc00::1/);
  });
});

describe("ssrf/readBodyWithCap", () => {
  function makeResponse(body: Uint8Array | null): Response {
    if (body === null) {
      return new Response(null);
    }
    // Cast through ArrayBuffer to keep TS happy across Node lib versions
    // — Uint8Array<ArrayBufferLike> doesn't widen to BlobPart in some libs.
    const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(new Blob([ab]));
  }

  it("returns an empty result for a null body", async () => {
    const r = makeResponse(null);
    const out = await readBodyWithCap(r, 1024);
    expect(out.text).toBe("");
    expect(out.truncated).toBe(false);
    expect(out.bytesRead).toBe(0);
  });

  it("returns the full body when under the cap", async () => {
    const r = makeResponse(new TextEncoder().encode("hello world"));
    const out = await readBodyWithCap(r, 1024);
    expect(out.text).toBe("hello world");
    expect(out.truncated).toBe(false);
    expect(out.bytesRead).toBe(11);
  });

  it("truncates at the cap and flags it", async () => {
    const big = new Uint8Array(2048).fill(0x41); // 2KB of 'A'
    const r = makeResponse(big);
    const out = await readBodyWithCap(r, 100);
    expect(out.text.length).toBe(100);
    expect(out.text).toBe("A".repeat(100));
    expect(out.truncated).toBe(true);
    // bytesRead is the count at the point we stopped reading — may
    // exceed the cap because we stop AFTER the chunk that tipped over.
    expect(out.bytesRead).toBeGreaterThanOrEqual(100);
  });
});

describe("subscriptions/validateUrl (prod mode)", () => {
  let nodeEnvBefore: string | undefined;
  beforeEach(() => {
    nodeEnvBefore = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    if (nodeEnvBefore === undefined) vi.unstubAllEnvs();
    else {
      vi.stubEnv("NODE_ENV", nodeEnvBefore);
      vi.unstubAllEnvs();
    }
  });

  it("rejects http:// (production)", () => {
    expect(() => validateUrl("http://example.com/hook")).toThrow(WebhookValidationError);
  });

  it("rejects every new blocked-host category", () => {
    const bad = [
      "https://localhost/hook",
      "https://api.local/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://svc.cluster.internal/hook",
      "https://10.0.0.5/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
    ];
    for (const url of bad) {
      expect(() => validateUrl(url), `expected ${url} to be rejected`).toThrow(WebhookValidationError);
    }
  });

  it("accepts a public https URL", () => {
    expect(() => validateUrl("https://hooks.example.com/path")).not.toThrow();
  });

  it("rejects credentials in URL", () => {
    expect(() => validateUrl("https://user:pass@example.com/hook")).toThrow(/credentials/);
  });
});

describe("deliver — DNS rebinding block end-to-end", () => {
  async function ensureTenantAndMember() {
    const tenant = await superDb.tenant.create({
      data: { slug: `ssrf-${randomUUID().slice(0, 8)}`, name: "ssrf test" },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.com`, name: "ssrf user" },
    });
    const membership = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    return { tenant, membership };
  }

  it("blocks delivery when the resolved IP is private, then dead-letters after maxAttempts", async () => {
    const { tenant, membership } = await ensureTenantAndMember();
    try {
      // Create a subscription with a public-looking hostname; the lookup
      // hook will resolve it to a private IP, simulating DNS rebinding.
      const created = await createSubscription({
        tenantId: tenant.id,
        actorMembershipId: membership.id,
        name: "ssrf victim",
        url: "https://looks-public.example/path",
        eventTypes: ["*"],
      });

      // Force a delivery row directly to avoid waiting for an audit event
      // to enqueue. Use a small maxAttempts so the deadletter path runs
      // in a few sweeps.
      const payload: WebhookPayload = {
        id: randomUUID(),
        tenantSlug: tenant.slug,
        eventType: "WEBHOOK_DELIVERED",
        occurredAt: new Date().toISOString(),
        subjectType: "Test",
        subjectId: randomUUID(),
        actorMembershipId: null,
        data: { ssrf: true },
      };
      const now = new Date();
      const delivery = await superDb.webhookDelivery.create({
        data: {
          tenantId: tenant.id,
          subscriptionId: created.subscription.id,
          eventType: "TEST_EVENT",
          payload: payload as unknown as object,
          status: "PENDING",
          scheduledFor: now,
          attempt: 0,
          maxAttempts: 2,
        },
      });

      const lookupImpl = async () => ({ address: "169.254.169.254", family: 4 });
      // fetch must NEVER be called — assert on this.
      let fetchCalled = false;
      const fetchImpl = (async () => {
        fetchCalled = true;
        return new Response("nope", { status: 200 });
      }) as unknown as typeof fetch;

      // First sweep: attempt 1, blocked, transitions back to PENDING with
      // backoff, lastError captures the SSRF reason.
      const r1 = await runWebhookDeliveryBatch({ fetchImpl, lookupImpl, now: () => now });
      expect(r1.picked).toBe(1);
      expect(r1.retried).toBe(1);
      expect(fetchCalled).toBe(false);
      const afterAttempt1 = await superDb.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(afterAttempt1.status).toBe("PENDING");
      expect(afterAttempt1.attempt).toBe(1);
      expect(afterAttempt1.lastError ?? "").toMatch(/egress blocked/);

      // Re-arm scheduledFor so the next sweep picks it up immediately.
      await superDb.webhookDelivery.update({
        where: { id: delivery.id },
        data: { scheduledFor: now },
      });

      // Second sweep: attempt 2 = maxAttempts, dead-letters.
      const r2 = await runWebhookDeliveryBatch({ fetchImpl, lookupImpl, now: () => now });
      expect(r2.picked).toBe(1);
      expect(r2.deadLettered).toBe(1);
      expect(fetchCalled).toBe(false);
      const afterAttempt2 = await superDb.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(afterAttempt2.status).toBe("DEAD_LETTERED");
      expect(afterAttempt2.lastError ?? "").toMatch(/egress blocked/);
    } finally {
      await superDb.webhookDelivery.deleteMany({ where: { tenantId: tenant.id } });
      await superDb.webhookSubscription.deleteMany({ where: { tenantId: tenant.id } });
      await superDb.membership.delete({ where: { id: membership.id } });
      await superDb.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("treats an unparseable URL as a permanent failure (dead-letter on first attempt)", async () => {
    const { tenant, membership } = await ensureTenantAndMember();
    try {
      // Bypass validateUrl by writing directly — represents a corrupted
      // row or an admin who escaped the validator via DB tooling.
      const sub = await superDb.webhookSubscription.create({
        data: {
          tenantId: tenant.id,
          name: "corrupted url",
          url: "::: not a url :::",
          secretEncrypted: (await import("@/lib/channels/crypto")).encryptJson("dummy"),
          eventTypes: ["*"],
          createdByMembershipId: membership.id,
        },
      });
      const payload: WebhookPayload = {
        id: randomUUID(),
        tenantSlug: tenant.slug,
        eventType: "WEBHOOK_DELIVERED",
        occurredAt: new Date().toISOString(),
        subjectType: "Test",
        subjectId: randomUUID(),
        actorMembershipId: null,
        data: {},
      };
      const now = new Date();
      const delivery = await superDb.webhookDelivery.create({
        data: {
          tenantId: tenant.id,
          subscriptionId: sub.id,
          eventType: "TEST_EVENT",
          payload: payload as unknown as object,
          status: "PENDING",
          scheduledFor: now,
          attempt: 0,
          maxAttempts: 5,
        },
      });

      const lookupImpl = async () => ({ address: "1.2.3.4", family: 4 });
      const fetchImpl = (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch;

      const r = await runWebhookDeliveryBatch({ fetchImpl, lookupImpl, now: () => now });
      expect(r.picked).toBe(1);
      expect(r.deadLettered).toBe(1);
      const after = await superDb.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(after.status).toBe("DEAD_LETTERED");
      expect(after.lastError ?? "").toMatch(/parseable/);
    } finally {
      await superDb.webhookDelivery.deleteMany({ where: { tenantId: tenant.id } });
      await superDb.webhookSubscription.deleteMany({ where: { tenantId: tenant.id } });
      await superDb.membership.delete({ where: { id: membership.id } });
      await superDb.tenant.delete({ where: { id: tenant.id } });
    }
  });
});
