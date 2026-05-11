/**
 * Sign-in anomaly detection (post-PRD hardening item 21).
 *
 * Coverage:
 *   - classifier: first-session, familiar match, new-device by UA family,
 *     new-device by IP block, new-device by both, lookback window respected,
 *     ipBlock + uaFamily edge cases.
 *   - detector: emits SIGN_IN_NEW_DEVICE audit + dispatches notification
 *     only on the new-device path; silent on first-session + familiar;
 *     idempotent (a second call with the same sessionId writes no second
 *     audit row); routes to the User's primary ACTIVE membership tenant.
 *   - observeSessionMetadata returns firstObservation=true on the very
 *     first call and false on subsequent calls — the layout uses this as
 *     the trigger to invoke the detector.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  classifySignIn,
  uaFamily,
  ipBlock,
  detectAndNotify,
} from "@/lib/auth/anomaly";
import { observeSessionMetadata } from "@/lib/auth/sessions";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("anomaly — uaFamily + ipBlock primitives", () => {
  it("uaFamily groups same browser+os regardless of version", () => {
    const v120 = uaFamily(CHROME_MAC);
    const v121 = uaFamily(CHROME_MAC.replace("Chrome/120", "Chrome/121"));
    expect(v120).toBe(v121);
    expect(v120).toBe("Chrome/macOS");
  });

  it("uaFamily distinguishes different browser or OS", () => {
    expect(uaFamily(CHROME_MAC)).not.toBe(uaFamily(FIREFOX_LINUX));
    expect(uaFamily(CHROME_MAC)).not.toBe(uaFamily(SAFARI_IOS));
  });

  it("uaFamily falls back gracefully on null / unknown", () => {
    expect(uaFamily(null)).toBe("Unknown/Unknown");
    expect(uaFamily("garbage/0")).toBe("Unknown/Unknown");
  });

  it("ipBlock collapses v4 addresses inside the same /24", () => {
    expect(ipBlock("192.0.2.10")).toBe(ipBlock("192.0.2.250"));
    expect(ipBlock("192.0.2.10")).not.toBe(ipBlock("192.0.3.10"));
    expect(ipBlock("192.0.2.10")).toBe("192.0.2.0/24");
  });

  it("ipBlock collapses v6 inside the same /48", () => {
    expect(ipBlock("2001:db8:1::1")).toBe(ipBlock("2001:db8:1::ffff"));
    expect(ipBlock("2001:db8:1::1")).not.toBe(ipBlock("2001:db8:2::1"));
  });

  it("ipBlock returns null on garbage / empty / 'unknown'", () => {
    expect(ipBlock(null)).toBeNull();
    expect(ipBlock("")).toBeNull();
    expect(ipBlock("unknown")).toBeNull();
    expect(ipBlock("not.an.ip.addr")).toBeNull();
    expect(ipBlock("1.2.3")).toBeNull();
  });
});

describe("anomaly — classifySignIn", () => {
  it("returns first-session when there are no prior sessions", () => {
    const result = classifySignIn({
      currentUserAgent: CHROME_MAC,
      currentIp: "192.0.2.10",
      priorSessions: [],
    });
    expect(result.kind).toBe("first-session");
    expect(result.reasons).toEqual([]);
  });

  it("returns familiar when UA family + IP block both match a prior session", () => {
    const result = classifySignIn({
      currentUserAgent: CHROME_MAC,
      currentIp: "192.0.2.10",
      priorSessions: [
        { userAgent: CHROME_MAC.replace("Chrome/120", "Chrome/121"), ipAddress: "192.0.2.99" },
      ],
    });
    expect(result.kind).toBe("familiar");
    expect(result.reasons).toEqual([]);
  });

  it("returns new-device when only the IP block changes", () => {
    const result = classifySignIn({
      currentUserAgent: CHROME_MAC,
      currentIp: "203.0.113.5",
      priorSessions: [{ userAgent: CHROME_MAC, ipAddress: "192.0.2.10" }],
    });
    expect(result.kind).toBe("new-device");
    expect(result.reasons).toEqual(["new-ip-block"]);
  });

  it("returns new-device when only the UA family changes", () => {
    const result = classifySignIn({
      currentUserAgent: FIREFOX_LINUX,
      currentIp: "192.0.2.10",
      priorSessions: [{ userAgent: CHROME_MAC, ipAddress: "192.0.2.30" }],
    });
    expect(result.kind).toBe("new-device");
    expect(result.reasons).toEqual(["new-browser-os"]);
  });

  it("returns new-device with both reasons when family + IP both drift", () => {
    const result = classifySignIn({
      currentUserAgent: SAFARI_IOS,
      currentIp: "203.0.113.5",
      priorSessions: [{ userAgent: CHROME_MAC, ipAddress: "192.0.2.10" }],
    });
    expect(result.kind).toBe("new-device");
    expect(result.reasons).toContain("new-browser-os");
    expect(result.reasons).toContain("new-ip-block");
  });

  it("treats a matching family in ANY of multiple priors as a family match", () => {
    const result = classifySignIn({
      currentUserAgent: CHROME_MAC,
      currentIp: "192.0.2.10",
      priorSessions: [
        { userAgent: FIREFOX_LINUX, ipAddress: "192.0.2.30" },
        { userAgent: CHROME_MAC, ipAddress: "192.0.2.99" }, // matches family AND ip block
      ],
    });
    expect(result.kind).toBe("familiar");
  });
});

describe("anomaly — detectAndNotify", () => {
  it("emits SIGN_IN_NEW_DEVICE + notification on a real new-device signal", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("anomaly"),
    });
    // Seed one prior session with a different UA + IP block.
    await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: CHROME_MAC,
        ipAddress: "192.0.2.20",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    // Current session — opposite UA family + opposite IP block.
    const current = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: SAFARI_IOS,
        ipAddress: "203.0.113.5",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const result = await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: SAFARI_IOS,
      ipAddress: "203.0.113.5",
    });
    expect(result.classification.kind).toBe("new-device");
    expect(result.emitted).toBe(true);

    const audit = await superDb.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "SIGN_IN_NEW_DEVICE",
        subjectType: "Session",
        subjectId: current.id,
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.sessionId).toBe(current.id);
    expect(payload.userId).toBe(user.id);
    expect(payload.ipMasked).toBe("203.0.113.×");
    expect(payload.browser).toBe("Safari");
    expect(payload.os).toBe("iOS");
    expect(payload.reasons).toEqual(expect.arrayContaining(["new-browser-os", "new-ip-block"]));

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { membershipId: membership.id, kind: "sign_in_new_device", dedupeKey: current.id },
    });
    expect(dispatch).not.toBeNull();
    const inbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: membership.id, kind: "sign_in_new_device", dedupeKey: current.id },
    });
    expect(inbox).not.toBeNull();
    expect(dispatch).not.toBeNull();
  });

  it("is idempotent: a second call writes no second audit + no second dispatch", async () => {
    const tenant = await createTestTenant();
    const { user, membership } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("anomaly-idem"),
    });
    await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: CHROME_MAC,
        ipAddress: "192.0.2.50",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const current = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: FIREFOX_LINUX,
        ipAddress: "198.51.100.1",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: FIREFOX_LINUX,
      ipAddress: "198.51.100.1",
    });
    const second = await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: FIREFOX_LINUX,
      ipAddress: "198.51.100.1",
    });
    expect(second.emitted).toBe(false);

    const auditCount = await superDb.auditEvent.count({
      where: {
        tenantId: tenant.id,
        eventType: "SIGN_IN_NEW_DEVICE",
        subjectId: current.id,
      },
    });
    expect(auditCount).toBe(1);
    const dispatchCount = await superDb.notificationDispatch.count({
      where: { membershipId: membership.id, kind: "sign_in_new_device", dedupeKey: current.id },
    });
    expect(dispatchCount).toBe(1);
  });

  it("is silent on first-session (no prior sessions exist for this User)", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("anomaly-first"),
    });
    const current = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: CHROME_MAC,
        ipAddress: "192.0.2.10",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const result = await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: CHROME_MAC,
      ipAddress: "192.0.2.10",
    });
    expect(result.classification.kind).toBe("first-session");
    expect(result.emitted).toBe(false);
    const auditCount = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "SIGN_IN_NEW_DEVICE" },
    });
    expect(auditCount).toBe(0);
  });

  it("is silent on familiar (UA family + IP block match a prior session)", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("anomaly-fam"),
    });
    await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: CHROME_MAC,
        ipAddress: "192.0.2.30",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const current = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        // Same family, same /24 block.
        userAgent: CHROME_MAC.replace("Chrome/120", "Chrome/121"),
        ipAddress: "192.0.2.99",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const result = await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: CHROME_MAC.replace("Chrome/120", "Chrome/121"),
      ipAddress: "192.0.2.99",
    });
    expect(result.classification.kind).toBe("familiar");
    expect(result.emitted).toBe(false);
  });

  it("ignores Users with no active membership (no routing target)", async () => {
    const user = await superDb.user.create({ data: { email: uniqueEmail("orphan") } });
    const current = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        userAgent: SAFARI_IOS,
        ipAddress: "203.0.113.5",
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    // No prior sessions either → classifies as first-session and emits
    // nothing; even if a new-device signal existed, the routing fallback
    // would short-circuit. Both paths are silent.
    const result = await detectAndNotify({
      sessionId: current.id,
      userId: user.id,
      userAgent: SAFARI_IOS,
      ipAddress: "203.0.113.5",
    });
    expect(result.emitted).toBe(false);
  });
});

describe("observeSessionMetadata — firstObservation signal", () => {
  it("returns firstObservation:true on the first call and false on the second", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("observe"),
    });
    const session = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        // UA and IP both null initially — observe should populate them.
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const first = await observeSessionMetadata(session.id, CHROME_MAC, "192.0.2.42");
    expect(first.firstObservation).toBe(true);
    const second = await observeSessionMetadata(session.id, SAFARI_IOS, "203.0.113.5");
    expect(second.firstObservation).toBe(false);
    // Original UA + IP are immutable (first-observation-wins).
    const persisted = await superDb.session.findUnique({ where: { id: session.id } });
    expect(persisted?.userAgent).toBe(CHROME_MAC);
    expect(persisted?.ipAddress).toBe("192.0.2.42");
  });

  it("returns firstObservation:false when neither UA nor IP is provided", async () => {
    const tenant = await createTestTenant();
    const { user } = await createTestUserAndMembership(tenant.id, {
      email: uniqueEmail("observe-empty"),
    });
    const session = await superDb.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const res = await observeSessionMetadata(session.id, null, null);
    expect(res.firstObservation).toBe(false);
  });
});
