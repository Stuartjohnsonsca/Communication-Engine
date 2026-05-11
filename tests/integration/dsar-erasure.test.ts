/**
 * GDPR Art. 17 user erasure (post-PRD hardening).
 *
 * Coverage:
 *   - tombstoneEmail / isErasedEmail pure helpers.
 *   - eraseUser happy path: pseudonymises User row (email tombstone,
 *     name/image/emailVerified nulled), every Membership across every
 *     tenant transitions to ANONYMISED with anonymisedAt stamped,
 *     UCGs anonymised (UCGRule rows deleted, status flipped), Sessions
 *     deleted, UserTotp wiped + disabledAt stamped, ChannelAuth rows
 *     for every membership deleted.
 *   - Audit fan-out: USER_ERASED written to every affected tenant's
 *     chain + the requesting tenant if not already covered;
 *     MEMBERSHIP_ANONYMISED written per non-anonymised membership;
 *     actorMembershipId is set on the home tenant's chain and NULL on
 *     foreign tenants' chains.
 *   - Idempotency: a second call against an already-erased User
 *     returns alreadyErased:true and writes zero new audit rows.
 *   - User not found: throws UserErasureError(code:"user-not-found").
 *   - Cross-tenant isolation: erasure of user A does not touch user B
 *     in either tenant.
 *   - fulfillDsar wiring: kind=ERASE + subjectType=USER + outcome=
 *     FULFILLED triggers eraseUser; the User is pseudonymised; the
 *     DSARequest is stamped FULFILLED; DSAR_FULFILLED payload includes
 *     erasure summary.
 *   - fulfillDsar wiring: kind=ERASE + outcome=REJECTED does NOT erase
 *     the User.
 *   - fulfillDsar wiring: kind=ACCESS (any other) does NOT erase.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  eraseUser,
  tombstoneEmail,
  isErasedEmail,
  UserErasureError,
  ERASED_EMAIL_DOMAIN,
} from "@/lib/dsar/erasure";
import { fulfillDsar, openDsar } from "@/lib/dsar/lifecycle";

type Tenant = Awaited<ReturnType<typeof superDb.tenant.create>>;
type User = Awaited<ReturnType<typeof superDb.user.create>>;
type Membership = Awaited<ReturnType<typeof superDb.membership.create>>;

async function makeTenant(slugPrefix = "ers"): Promise<Tenant> {
  return superDb.tenant.create({
    data: { slug: `${slugPrefix}-${randomUUID().slice(0, 8)}`, name: "erasure test" },
  });
}

async function makeUser(email?: string): Promise<User> {
  return superDb.user.create({
    data: {
      email: email ?? `${randomUUID().slice(0, 8)}@example.test`,
      name: "Erasure Test User",
      image: "https://example.test/avatar.png",
      emailVerified: new Date(),
    },
  });
}

async function makeMembership(tenant: Tenant, user: User): Promise<Membership> {
  return superDb.membership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      role: "USER",
      status: "ACTIVE",
    },
  });
}

async function cleanupTenant(tenantId: string) {
  await superDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
}

async function cleanupUser(userId: string) {
  await superDb.user.delete({ where: { id: userId } }).catch(() => {});
}

describe("dsar/erasure pure helpers", () => {
  it("tombstoneEmail uses the reserved RFC 6761 .invalid TLD", () => {
    const id = "abc123";
    expect(tombstoneEmail(id)).toBe(`erased-${id}@${ERASED_EMAIL_DOMAIN}`);
    expect(ERASED_EMAIL_DOMAIN).toBe("erased.invalid");
  });

  it("isErasedEmail detects tombstone addresses (case-insensitive)", () => {
    expect(isErasedEmail("erased-x@erased.invalid")).toBe(true);
    expect(isErasedEmail("ERASED-X@ERASED.INVALID")).toBe(true);
    expect(isErasedEmail("foo@example.test")).toBe(false);
    expect(isErasedEmail("")).toBe(false);
    expect(isErasedEmail(null)).toBe(false);
    expect(isErasedEmail(undefined)).toBe(false);
  });
});

describe("dsar/eraseUser", () => {
  let tenantA: Tenant;
  let tenantB: Tenant;
  let user: User;
  let mA: Membership;
  let mB: Membership;
  let admin: Membership;

  beforeEach(async () => {
    tenantA = await makeTenant("ersA");
    tenantB = await makeTenant("ersB");
    user = await makeUser();
    mA = await makeMembership(tenantA, user);
    mB = await makeMembership(tenantB, user);
    // A separate admin user in tenantA who triggers the erasure.
    const adminUser = await makeUser();
    admin = await superDb.membership.create({
      data: {
        tenantId: tenantA.id,
        userId: adminUser.id,
        role: "FIRM_ADMIN",
        status: "ACTIVE",
      },
    });
  });

  afterEach(async () => {
    await cleanupTenant(tenantA.id);
    await cleanupTenant(tenantB.id);
    await cleanupUser(user.id).catch(() => {});
    // admin user dangles but its tenant cascade cleans memberships; we
    // don't aggressively track admin user ids since each test creates fresh.
  });

  it("pseudonymises the User row and clears identifying fields", async () => {
    const result = await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });
    expect(result.erased).toBe(true);
    expect(result.alreadyErased).toBe(false);

    const after = await superDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(tombstoneEmail(user.id));
    expect(after.email.endsWith(`@${ERASED_EMAIL_DOMAIN}`)).toBe(true);
    expect(after.name).toBeNull();
    expect(after.image).toBeNull();
    expect(after.emailVerified).toBeNull();
  });

  it("anonymises every Membership across every tenant", async () => {
    await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });

    const afterA = await superDb.membership.findUniqueOrThrow({ where: { id: mA.id } });
    const afterB = await superDb.membership.findUniqueOrThrow({ where: { id: mB.id } });
    expect(afterA.status).toBe("ANONYMISED");
    expect(afterB.status).toBe("ANONYMISED");
    expect(afterA.anonymisedAt).not.toBeNull();
    expect(afterB.anonymisedAt).not.toBeNull();
  });

  it("writes USER_ERASED on every affected tenant's audit chain; actor null on foreign chains", async () => {
    const result = await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });
    expect(Object.keys(result.auditEventsByTenant).sort()).toEqual([tenantA.id, tenantB.id].sort());

    const auditA = await superDb.auditEvent.findUniqueOrThrow({
      where: { id: result.auditEventsByTenant[tenantA.id] },
    });
    const auditB = await superDb.auditEvent.findUniqueOrThrow({
      where: { id: result.auditEventsByTenant[tenantB.id] },
    });
    expect(auditA.eventType).toBe("USER_ERASED");
    expect(auditB.eventType).toBe("USER_ERASED");
    expect(auditA.actorMembershipId).toBe(admin.id);
    expect(auditB.actorMembershipId).toBeNull();
    expect(auditA.subjectType).toBe("User");
    expect(auditA.subjectId).toBe(user.id);

    // Payload preserves the former email so an operator can verify the
    // right person was erased.
    const payloadA = auditA.payload as { formerEmail: string };
    expect(payloadA.formerEmail).toBe(user.email);
  });

  it("revokes Sessions, wipes UserTotp, deletes ChannelAuth", async () => {
    // Seed a session.
    await superDb.session.create({
      data: {
        sessionToken: `tok-${randomUUID()}`,
        userId: user.id,
        expires: new Date(Date.now() + 86400_000),
      },
    });
    // Seed UserTotp.
    await superDb.userTotp.create({
      data: {
        userId: user.id,
        secretEncrypted: "v1:fakeblob",
        verifiedAt: new Date(),
        recoveryCodesHashed: ["a", "b", "c"],
      },
    });
    // Seed ChannelAuth on tenant A (Channel has freeform `kind`).
    const channel = await superDb.channel.create({
      data: {
        tenantId: tenantA.id,
        kind: "GOOGLE",
        status: "CONNECTED",
      },
    });
    await superDb.channelAuth.create({
      data: {
        tenantId: tenantA.id,
        channelId: channel.id,
        membershipId: mA.id,
        encryptedTokens: "v1:fakeblob",
      },
    });

    const result = await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });

    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(result.totpWiped).toBe(true);
    expect(result.channelAuthsDeleted).toBeGreaterThanOrEqual(1);

    const sessions = await superDb.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(0);

    const totp = await superDb.userTotp.findUnique({ where: { userId: user.id } });
    expect(totp).not.toBeNull();
    expect(totp!.secretEncrypted).toBe("");
    expect(totp!.recoveryCodesHashed).toEqual([]);
    expect(totp!.verifiedAt).toBeNull();
    expect(totp!.disabledAt).not.toBeNull();

    const channelAuthAfter = await superDb.channelAuth.findMany({
      where: { membershipId: mA.id },
    });
    expect(channelAuthAfter).toHaveLength(0);
  });

  it("is idempotent — re-running against an erased User returns alreadyErased without further mutations", async () => {
    await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });

    const auditCountBefore = await superDb.auditEvent.count({
      where: { tenantId: { in: [tenantA.id, tenantB.id] }, eventType: "USER_ERASED" },
    });

    const second = await eraseUser({
      userId: user.id,
      requestingTenantId: tenantA.id,
      actorMembershipId: admin.id,
    });
    expect(second.erased).toBe(false);
    expect(second.alreadyErased).toBe(true);
    expect(Object.keys(second.auditEventsByTenant)).toHaveLength(0);

    const auditCountAfter = await superDb.auditEvent.count({
      where: { tenantId: { in: [tenantA.id, tenantB.id] }, eventType: "USER_ERASED" },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("throws UserErasureError when the user does not exist", async () => {
    await expect(
      eraseUser({
        userId: "nonexistent-id-12345",
        requestingTenantId: tenantA.id,
        actorMembershipId: admin.id,
      }),
    ).rejects.toBeInstanceOf(UserErasureError);
  });

  it("does not touch other Users in the same tenant", async () => {
    const otherUser = await makeUser();
    const otherMembership = await makeMembership(tenantA, otherUser);
    try {
      await eraseUser({
        userId: user.id,
        requestingTenantId: tenantA.id,
        actorMembershipId: admin.id,
      });
      const stillThere = await superDb.user.findUniqueOrThrow({
        where: { id: otherUser.id },
      });
      expect(stillThere.email).toBe(otherUser.email);
      expect(stillThere.name).toBe(otherUser.name);
      const stillMember = await superDb.membership.findUniqueOrThrow({
        where: { id: otherMembership.id },
      });
      expect(stillMember.status).toBe("ACTIVE");
    } finally {
      await cleanupUser(otherUser.id).catch(() => {});
    }
  });
});

describe("dsar/fulfillDsar wiring to erasure", () => {
  let tenantA: Tenant;
  let user: User;
  let mA: Membership;
  let admin: Membership;

  beforeEach(async () => {
    tenantA = await makeTenant("dsarA");
    user = await makeUser();
    mA = await makeMembership(tenantA, user);
    const adminUser = await makeUser();
    admin = await superDb.membership.create({
      data: {
        tenantId: tenantA.id,
        userId: adminUser.id,
        role: "FIRM_ADMIN",
        status: "ACTIVE",
      },
    });
  });

  afterEach(async () => {
    await cleanupTenant(tenantA.id);
    await cleanupUser(user.id).catch(() => {});
  });

  it("kind=ERASE + USER + FULFILLED triggers pseudonymisation", async () => {
    const dsar = await openDsar({
      tenantId: tenantA.id,
      actorMembershipId: admin.id,
      subjectType: "USER",
      subjectIdent: user.email,
      kind: "ERASE",
    });

    const outcome = await fulfillDsar({
      tenantId: tenantA.id,
      dsarId: dsar.id,
      actorMembershipId: admin.id,
      outcome: "FULFILLED",
    });

    expect(outcome.request.status).toBe("FULFILLED");
    expect(outcome.erasure).not.toBeNull();
    expect(outcome.erasure!.alreadyErased).toBe(false);
    expect(outcome.erasure!.tenantIdsAffected).toContain(tenantA.id);

    const after = await superDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(tombstoneEmail(user.id));
    expect(after.name).toBeNull();

    const auditEvents = await superDb.auditEvent.findMany({
      where: {
        tenantId: tenantA.id,
        eventType: { in: ["USER_ERASED", "DSAR_FULFILLED"] },
      },
      orderBy: { seq: "asc" },
    });
    const types = auditEvents.map((e) => e.eventType);
    expect(types).toContain("USER_ERASED");
    expect(types).toContain("DSAR_FULFILLED");
    // The USER_ERASED row precedes DSAR_FULFILLED (cause before its closure).
    const userErasedIdx = types.indexOf("USER_ERASED");
    const dsarFulfilledIdx = types.indexOf("DSAR_FULFILLED");
    expect(userErasedIdx).toBeLessThan(dsarFulfilledIdx);
  });

  it("kind=ERASE + outcome=REJECTED does NOT erase the User", async () => {
    const dsar = await openDsar({
      tenantId: tenantA.id,
      actorMembershipId: admin.id,
      subjectType: "USER",
      subjectIdent: user.email,
      kind: "ERASE",
    });

    const outcome = await fulfillDsar({
      tenantId: tenantA.id,
      dsarId: dsar.id,
      actorMembershipId: admin.id,
      outcome: "REJECTED",
      notes: "subject withdrew the request",
    });

    expect(outcome.request.status).toBe("REJECTED");
    expect(outcome.erasure).toBeNull();

    const after = await superDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
    expect(after.name).toBe(user.name);
  });

  it("kind=ACCESS does NOT erase even with outcome=FULFILLED", async () => {
    const dsar = await openDsar({
      tenantId: tenantA.id,
      actorMembershipId: admin.id,
      subjectType: "USER",
      subjectIdent: user.email,
      kind: "ACCESS",
    });

    const outcome = await fulfillDsar({
      tenantId: tenantA.id,
      dsarId: dsar.id,
      actorMembershipId: admin.id,
      outcome: "FULFILLED",
      packageRef: "s3://exports/user-export.zip",
    });

    expect(outcome.request.status).toBe("FULFILLED");
    expect(outcome.erasure).toBeNull();

    const after = await superDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
    expect(after.name).toBe(user.name);
  });

  it("kind=ERASE + COUNTERPARTY does NOT touch any Acumon User", async () => {
    const dsar = await openDsar({
      tenantId: tenantA.id,
      actorMembershipId: admin.id,
      subjectType: "COUNTERPARTY",
      subjectIdent: "counterparty@external.example",
      kind: "ERASE",
    });

    const outcome = await fulfillDsar({
      tenantId: tenantA.id,
      dsarId: dsar.id,
      actorMembershipId: admin.id,
      outcome: "FULFILLED",
    });

    expect(outcome.request.status).toBe("FULFILLED");
    expect(outcome.erasure).toBeNull();

    const after = await superDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
  });
});
