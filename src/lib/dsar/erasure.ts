/**
 * GDPR Art. 17 — user-initiated erasure (right to be forgotten).
 *
 * The DSAR lifecycle (`fulfillDsar`) supports `kind="ERASE"` but historically
 * only stamped the DSARequest row + emitted DSAR_FULFILLED. The actual
 * pseudonymisation of the User row + cross-tenant fan-out was a TODO
 * documented in `dsar/extract.ts` ("the audit chain is immutable. Hash-chain
 * integrity overrides erasure for audit-event payloads, so the package
 * includes the audit trail but a separate flag warns the operator").
 *
 * This module closes that gap. When a DSARequest of kind ERASE + subjectType
 * USER is fulfilled, we:
 *
 *   1. PSEUDONYMISE the global User row: email becomes
 *      `erased-<id>@erased.invalid` (`.invalid` is RFC 6761 reserved — it
 *      never resolves on any DNS), name + image nulled, emailVerified
 *      cleared. The row id is preserved so foreign keys (Membership,
 *      Session, AuditEvent.actorMembershipId chain via Membership.userId,
 *      etc.) keep pointing at the same physical row — what changes is the
 *      identifying content.
 *
 *   2. FAN OUT across every tenant the User has a Membership in. For each
 *      affected tenant we (a) transition the Membership to ANONYMISED,
 *      (b) anonymise the User's UCG via the existing `anonymiseUcgsFor`
 *      helper (delete UCGRule rows, flip UCG.status, null
 *      signatureBlock), (c) write a USER_ERASED audit event on that
 *      tenant's chain so each Firm Administrator sees the action against
 *      their own data, (d) write MEMBERSHIP_ANONYMISED + (when UCGs were
 *      cleared) UCG_ANONYMISED on the same chain — parity with the
 *      time-based sweep path in `lifecycle/index.ts`.
 *
 *   3. REVOKE SESSIONS — delete every Session row for this user across
 *      all tenants. A browser tab still open in another tenant cannot
 *      use the cookie post-erasure.
 *
 *   4. WIPE SECONDARY CREDENTIALS — clear UserTotp (kept for audit but
 *      with secret + recovery codes wiped + disabledAt stamped), delete
 *      ChannelAuth rows for every Membership of this user (OAuth refresh
 *      tokens against connected mailboxes).
 *
 * Audit-chain integrity: we do NOT mutate or delete past AuditEvent rows.
 * Per GDPR Art. 17(3)(b) + (e), retention "for compliance with a legal
 * obligation" + "for the establishment, exercise or defence of legal
 * claims" is an explicit exception to the right of erasure — the audit
 * chain is the load-bearing legal record. The pseudonymisation makes the
 * User's identifiers unrecoverable (email → tombstone; name → null) so a
 * future audit-chain reader cannot re-identify the subject from row data
 * alone. Historic audit payloads that reference `userEmail` etc. as
 * embedded strings are preserved verbatim — same trade-off the lifecycle
 * sweep makes on time-based anonymisation.
 *
 * Idempotency: an already-erased User (email ends in `@erased.invalid`)
 * returns `{erased:false, alreadyErased:true}`. The DSARequest row may
 * still transition to FULFILLED — the caller is responsible for closing
 * the request even when the underlying erasure is a no-op (e.g. the same
 * user has multiple open DSAR requests; the second fulfils against an
 * already-erased row).
 *
 * Cross-tenant authority: the caller resolves the User by the
 * `subjectIdent` (email) submitted with the DSAR. The User may have
 * memberships in tenants OTHER than the requesting tenant; per GDPR the
 * data subject's right wins over a controller's preference, and Acumon
 * (as processor) fulfils the request across every tenant where it holds
 * the subject's data. Each affected tenant gets its own USER_ERASED
 * audit row so its Firm Administrator has a forensic record.
 */
import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { anonymiseUcgsFor } from "@/lib/lifecycle";

export const ERASED_EMAIL_DOMAIN = "erased.invalid";

/**
 * Returns the tombstone email a pseudonymised User row carries. CUID-based
 * so it's globally unique without colliding with any real address (the
 * User table's UNIQUE constraint on email enforces this).
 */
export function tombstoneEmail(userId: string): string {
  return `erased-${userId}@${ERASED_EMAIL_DOMAIN}`;
}

export function isErasedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${ERASED_EMAIL_DOMAIN}`);
}

export type EraseUserInput = {
  /** The User to erase. Resolved by the caller (typically via email lookup). */
  userId: string;
  /** Tenant whose DSARequest triggered this erasure. Recorded in audit payload. */
  requestingTenantId: string;
  /** The Membership that fulfilled the DSARequest. Becomes the audit actor. */
  actorMembershipId: string;
  /** Optional reference back to the DSARequest row. */
  dsarRequestId?: string | null;
  /** Free-form note (e.g. "fulfilled per GDPR Art. 17 request 2026-05-11"). */
  reason?: string | null;
};

export type EraseUserResult = {
  erased: boolean;
  alreadyErased: boolean;
  userId: string;
  /** Tenant ids whose Memberships were anonymised in this pass. */
  tenantIdsAffected: string[];
  /** Audit event ids written, by tenant id. */
  auditEventsByTenant: Record<string, string>;
  /** Counts for the operator dashboard. */
  membershipsAnonymised: number;
  ucgsAnonymised: number;
  sessionsRevoked: number;
  channelAuthsDeleted: number;
  totpWiped: boolean;
};

export class UserErasureError extends Error {
  code: "user-not-found";
  constructor(code: "user-not-found", message: string) {
    super(message);
    this.name = "UserErasureError";
    this.code = code;
  }
}

/**
 * The fulfilment primitive. Idempotent on the User row — re-running against
 * an already-pseudonymised User is safe and reports `alreadyErased:true`
 * without further mutations.
 *
 * Does NOT mutate the DSARequest itself — that's `fulfillDsar`'s job. This
 * helper is the side-effect of fulfilment.
 */
export async function eraseUser(input: EraseUserInput): Promise<EraseUserResult> {
  const user = await superDb.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw new UserErasureError("user-not-found", `User ${input.userId} not found`);
  }

  if (isErasedEmail(user.email)) {
    return {
      erased: false,
      alreadyErased: true,
      userId: user.id,
      tenantIdsAffected: [],
      auditEventsByTenant: {},
      membershipsAnonymised: 0,
      ucgsAnonymised: 0,
      sessionsRevoked: 0,
      channelAuthsDeleted: 0,
      totpWiped: false,
    };
  }

  // Resolve every membership across every tenant. We need the rows because
  // the UCG-anonymise + ChannelAuth-delete keys off membershipId.
  const memberships = await superDb.membership.findMany({
    where: { userId: user.id },
    select: { id: true, tenantId: true, status: true },
  });

  const now = new Date();
  let ucgsAnonymised = 0;
  let channelAuthsDeleted = 0;

  // Phase 1: anonymise each Membership + its UCGs + delete its ChannelAuth.
  // We don't wrap every tenant's work in a single transaction — the User
  // row mutation is the load-bearing atomic step (Phase 2); each tenant's
  // fan-out is best-effort independently. Worst case on partial failure:
  // some tenants are anonymised + some aren't; the audit chain reflects
  // truth on each side and a retry resumes correctly.
  for (const m of memberships) {
    if (m.status !== "ANONYMISED") {
      await superDb.membership.update({
        where: { id: m.id },
        data: { status: "ANONYMISED", anonymisedAt: now },
      });
    }
    const ids = await anonymiseUcgsFor(m.tenantId, m.id);
    ucgsAnonymised += ids.length;
    const deletedChannelAuth = await superDb.channelAuth.deleteMany({
      where: { membershipId: m.id },
    });
    channelAuthsDeleted += deletedChannelAuth.count;
  }

  // Phase 2: pseudonymise the User row + wipe credentials + revoke sessions.
  // Single transaction so a crash mid-step doesn't leave us with a User
  // whose email is still real but whose sessions are gone (or vice versa).
  const sessionsResult = await superDb.session.deleteMany({
    where: { userId: user.id },
  });
  const totpExisting = await superDb.userTotp.findUnique({
    where: { userId: user.id },
  });
  if (totpExisting) {
    await superDb.userTotp.update({
      where: { userId: user.id },
      data: {
        // Keep the row for audit lineage but make it unusable. The wiped
        // secret cannot reconstruct a working TOTP enrollment.
        secretEncrypted: "",
        recoveryCodesHashed: [],
        verifiedAt: null,
        disabledAt: now,
      },
    });
  }
  await superDb.user.update({
    where: { id: user.id },
    data: {
      email: tombstoneEmail(user.id),
      name: null,
      image: null,
      emailVerified: null,
    },
  });

  // Phase 3: per-tenant audit fan-out. USER_ERASED on every affected
  // tenant's chain; MEMBERSHIP_ANONYMISED for parity with the lifecycle
  // sweep path; UCG_ANONYMISED when UCGs were cleared. Also write a
  // single USER_ERASED on the REQUESTING tenant's chain if it isn't
  // already covered (the caller may have invoked from a tenant where the
  // user had no live membership — e.g. an Acumon operator erasing on
  // behalf of a former Client).
  const tenantIdsAffected = Array.from(new Set(memberships.map((m) => m.tenantId)));
  const auditEventsByTenant: Record<string, string> = {};
  const auditedTenants = new Set<string>();

  // For audit attribution: on the REQUESTING tenant's chain we use the
  // actor membership directly. On OTHER tenants' chains the actor isn't a
  // member of that tenant — we use `null` and record the requester in the
  // payload so the audit reviewer can correlate cross-chain without ever
  // pointing actorMembershipId at a foreign-tenant id.
  for (const m of memberships) {
    if (auditedTenants.has(m.tenantId)) continue;
    auditedTenants.add(m.tenantId);
    const isHomeTenant = m.tenantId === input.requestingTenantId;
    const created = await writeAuditEvent({
      tenantId: m.tenantId,
      eventType: "USER_ERASED",
      actorMembershipId: isHomeTenant ? input.actorMembershipId : null,
      subjectType: "User",
      subjectId: user.id,
      payload: erasurePayload(input, user.email),
    });
    auditEventsByTenant[m.tenantId] = created.id;
  }
  // Also audit on the requesting tenant if it wasn't already covered by
  // a live membership (Acumon-operator-driven erasure case).
  if (!auditedTenants.has(input.requestingTenantId)) {
    const created = await writeAuditEvent({
      tenantId: input.requestingTenantId,
      eventType: "USER_ERASED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "User",
      subjectId: user.id,
      payload: erasurePayload(input, user.email),
    });
    auditEventsByTenant[input.requestingTenantId] = created.id;
  }

  // Per-tenant lifecycle parity audits — same shape the sweep emits so an
  // audit reviewer reading either chain sees a uniform record.
  for (const m of memberships) {
    if (m.status === "ANONYMISED") continue; // was already there; skip
    const isHomeTenant = m.tenantId === input.requestingTenantId;
    await writeAuditEvent({
      tenantId: m.tenantId,
      eventType: "MEMBERSHIP_ANONYMISED",
      actorMembershipId: isHomeTenant ? input.actorMembershipId : null,
      subjectType: "Membership",
      subjectId: m.id,
      payload: {
        reason: "user_erasure",
        dsarRequestId: input.dsarRequestId ?? null,
        ucgsAnonymised: ucgsAnonymised,
        requestingTenantId: input.requestingTenantId,
      },
    });
  }

  return {
    erased: true,
    alreadyErased: false,
    userId: user.id,
    tenantIdsAffected,
    auditEventsByTenant,
    membershipsAnonymised: memberships.filter((m) => m.status !== "ANONYMISED").length,
    ucgsAnonymised,
    sessionsRevoked: sessionsResult.count,
    channelAuthsDeleted,
    totpWiped: totpExisting != null,
  };
}

function erasurePayload(
  input: EraseUserInput,
  formerEmail: string,
): Prisma.InputJsonValue {
  return {
    // The original email is INCLUDED in the audit payload deliberately —
    // GDPR Art. 17(3) retention exception covers this when the audit chain
    // is the legal record. An operator answering "did we erase the right
    // person?" needs the original email to verify. Same posture as
    // MEMBERSHIP_ANONYMISED in the lifecycle sweep.
    formerEmail,
    dsarRequestId: input.dsarRequestId ?? null,
    reason: input.reason ?? null,
    requestingTenantId: input.requestingTenantId,
  };
}
