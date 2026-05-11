/**
 * Backlog item 45 — per-User notification email preferences.
 *
 * Coverage:
 *   - Default (no row): opt-outable kinds receive email.
 *   - Toggle off opt-outable kind: dispatchNotification returns
 *     SKIPPED_USER_PREFERENCE; inbox row created with emailSentAt null.
 *   - Mandatory kinds short-circuit: directly inserting a preference row
 *     for a mandatory kind is ignored — email still sends.
 *   - `setEmailEnabled` for a non-opt-outable kind throws
 *     ValidationError.
 *   - Toggling to the same value does not write an audit event (no-op
 *     transitions are silent); a real flip writes
 *     NOTIFICATION_PREFERENCE_CHANGED with the prior + new value.
 *   - Tenant-A's preference does not affect Tenant-B's membership.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";
import {
  dispatchNotification,
  setEmailEnabled,
  getEmailEnabled,
  listPreferences,
} from "@/lib/notifications";
import { ValidationError } from "@/lib/api-errors";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("Notification preferences — defaults + mute behaviour", () => {
  beforeEach(() => {
    // No SMTP in CI — dispatchNotification's "successful" status is
    // SKIPPED_NO_EMAIL_SERVER, not DISPATCHED. The opt-out path skips
    // the SMTP call entirely and is reported as
    // SKIPPED_USER_PREFERENCE.
    delete process.env.EMAIL_SERVER;
    delete process.env.EMAIL_FROM;
  });

  it("default (no row): opt-outable kind dispatches normally", async () => {
    const t = await createTestTenant();
    const { membership, user } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("default"),
    });
    expect(await getEmailEnabled(membership.id, "weekly_digest")).toBe(true);

    const r = await dispatchNotification({
      tenantId: t.id,
      membershipId: membership.id,
      toEmail: user.email,
      kind: "weekly_digest",
      dedupeKey: "default-test",
      subject: "x",
      text: "x",
    });
    expect(r.status).toBe("SKIPPED_NO_EMAIL_SERVER");

    const inbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: membership.id, kind: "weekly_digest" },
    });
    expect(inbox?.emailSentAt).toBeNull();
  });

  it("muting weekly_digest yields SKIPPED_USER_PREFERENCE and still writes inbox", async () => {
    const t = await createTestTenant();
    const { membership, user } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("mute"),
    });

    await setEmailEnabled({
      tenantId: t.id,
      membershipId: membership.id,
      actorMembershipId: membership.id,
      kind: "weekly_digest",
      emailEnabled: false,
    });

    const prefs = await listPreferences(membership.id);
    expect(prefs.weekly_digest).toBe(false);
    expect(prefs.sign_in_new_device).toBe(true);

    const r = await dispatchNotification({
      tenantId: t.id,
      membershipId: membership.id,
      toEmail: user.email,
      kind: "weekly_digest",
      dedupeKey: "mute-test",
      subject: "x",
      text: "x",
    });
    expect(r.status).toBe("SKIPPED_USER_PREFERENCE");

    const inbox = await superDb.notificationInbox.findFirst({
      where: { membershipId: membership.id, kind: "weekly_digest", dedupeKey: "mute-test" },
    });
    expect(inbox).toBeTruthy();
    expect(inbox?.emailSentAt).toBeNull();

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { membershipId: membership.id, kind: "weekly_digest", dedupeKey: "mute-test" },
    });
    expect(dispatch?.status).toBe("SKIPPED_USER_PREFERENCE");
  });

  it("mandatory kind: preference row inserted directly into DB is silently ignored", async () => {
    const t = await createTestTenant();
    const { membership, user } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("mandatory"),
    });
    // Bypass setEmailEnabled (which throws for mandatory kinds) and
    // poke a row directly. The dispatcher's `isOptOutable` short-circuit
    // is the gate.
    await superDb.membershipNotificationPreference.create({
      data: {
        tenantId: t.id,
        membershipId: membership.id,
        kind: "breach_ack_required",
        emailEnabled: false,
      },
    });

    const r = await dispatchNotification({
      tenantId: t.id,
      membershipId: membership.id,
      toEmail: user.email,
      kind: "breach_ack_required",
      dedupeKey: "mandatory-test",
      subject: "x",
      text: "x",
    });
    // Mandatory kinds bypass the preference lookup. With no SMTP in CI
    // this is SKIPPED_NO_EMAIL_SERVER (NOT SKIPPED_USER_PREFERENCE).
    expect(r.status).toBe("SKIPPED_NO_EMAIL_SERVER");
  });

  it("setEmailEnabled on a mandatory kind throws ValidationError", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("reject"),
    });
    await expect(
      setEmailEnabled({
        tenantId: t.id,
        membershipId: membership.id,
        actorMembershipId: membership.id,
        kind: "breach_ack_required",
        emailEnabled: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("real flip writes NOTIFICATION_PREFERENCE_CHANGED; no-op flip is silent", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("audit"),
    });

    // First flip: true → false.
    await setEmailEnabled({
      tenantId: t.id,
      membershipId: membership.id,
      actorMembershipId: membership.id,
      kind: "weekly_digest",
      emailEnabled: false,
    });
    const auditAfterFirst = await superDb.auditEvent.count({
      where: { tenantId: t.id, eventType: "NOTIFICATION_PREFERENCE_CHANGED" },
    });
    expect(auditAfterFirst).toBe(1);

    // Same value again — no-op transition, no new audit entry.
    await setEmailEnabled({
      tenantId: t.id,
      membershipId: membership.id,
      actorMembershipId: membership.id,
      kind: "weekly_digest",
      emailEnabled: false,
    });
    const auditAfterSame = await superDb.auditEvent.count({
      where: { tenantId: t.id, eventType: "NOTIFICATION_PREFERENCE_CHANGED" },
    });
    expect(auditAfterSame).toBe(1);

    // Flip back — second audit entry.
    await setEmailEnabled({
      tenantId: t.id,
      membershipId: membership.id,
      actorMembershipId: membership.id,
      kind: "weekly_digest",
      emailEnabled: true,
    });
    const auditAfterRevert = await superDb.auditEvent.count({
      where: { tenantId: t.id, eventType: "NOTIFICATION_PREFERENCE_CHANGED" },
    });
    expect(auditAfterRevert).toBe(2);
  });

  it("tenant-A preference does not affect tenant-B membership", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const { membership: memberA } = await createTestUserAndMembership(a.id, {
      role: "USER",
      email: uniqueEmail("tenant-a"),
    });
    const { membership: memberB } = await createTestUserAndMembership(b.id, {
      role: "USER",
      email: uniqueEmail("tenant-b"),
    });

    await setEmailEnabled({
      tenantId: a.id,
      membershipId: memberA.id,
      actorMembershipId: memberA.id,
      kind: "weekly_digest",
      emailEnabled: false,
    });

    expect(await getEmailEnabled(memberA.id, "weekly_digest")).toBe(false);
    expect(await getEmailEnabled(memberB.id, "weekly_digest")).toBe(true);
  });
});
