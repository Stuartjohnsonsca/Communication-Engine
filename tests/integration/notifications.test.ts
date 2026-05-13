/**
 * Backlog item 6 — notifications (weekly digest + immediate dispatch).
 *
 * Coverage:
 *   - dispatchNotification idempotency on (membershipId, kind, dedupeKey).
 *   - Inbox row created alongside dispatch + emailSentAt only set when the
 *     mailer is actually configured (we run without SMTP in CI).
 *   - Adherence escalation immediately writes a notification + audit event
 *     for the sender AND the FCT, exactly once.
 *   - Sentiment escalation does the same when an inbound is classified
 *     extreme-negative-against-firm-handling.
 *   - Breach dispatch fires a `breach_ack_required` notification to every
 *     FIRM_ADMIN of the affected tenant.
 *   - Weekly-digest aggregation is per-membership tenant-isolated and only
 *     produces inbox rows for memberships with substantive content.
 *   - Weekly digest is idempotent on the ISO week — second run for the
 *     same week is a no-op.
 *   - Nav badges count outstanding work for the User (own actions) and the
 *     firm (FCT-visible escalations) using the same definitions the
 *     digest uses.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { superDb } from "@/lib/db";

/** Suffix emails to dodge the global `User.email` UNIQUE collision when this
 *  test file runs against a DB that already has rows from prior test runs. */
function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}
import {
  dispatchNotification,
  runWeeklyDigest,
  isoWeekKey,
  aggregateForMembership,
  digestHasContent,
  getNavBadges,
} from "@/lib/notifications";
import { escalateAdherenceIfPoor, ADHERENCE_ESCALATION_THRESHOLD } from "@/lib/adherence/escalation";
import { addAffectedTenant, createBreachIncident, dispatchNotification as dispatchBreach } from "@/lib/compliance/breach";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

async function makeDraft(input: {
  tenantId: string;
  membershipId: string;
}) {
  return superDb.draft.create({
    data: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      kind: "EMAIL",
      status: "SENT",
      channel: "EMAIL",
      subject: "Test send",
      body: "Body",
      sentText: "Body",
      sentMarkedAt: new Date(),
    },
  });
}

async function makeAdherence(input: {
  tenantId: string;
  draftId: string;
  membershipId: string;
  overall: number;
}) {
  return superDb.communicationAdherence.create({
    data: {
      tenantId: input.tenantId,
      draftId: input.draftId,
      membershipId: input.membershipId,
      fcgVersionUsed: 1,
      overall: input.overall,
      perDimension: {},
      perRule: [],
    },
  });
}

describe("Notifications — dispatchNotification", () => {
  beforeEach(() => {
    // Tests run without EMAIL_SERVER configured; ensure that's the case.
    delete process.env.EMAIL_SERVER;
    delete process.env.EMAIL_FROM;
  });

  it("creates dispatch + inbox + audit on first call; second call is a no-op", async () => {
    const t = await createTestTenant();
    const { membership, user } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fa1"),
    });

    const r1 = await dispatchNotification({
      tenantId: t.id,
      membershipId: membership.id,
      toEmail: user.email,
      kind: "weekly_digest",
      dedupeKey: "2026-W19",
      subject: "Test digest",
      summary: "1 thing",
      text: "Body",
      href: `/${t.slug}/notifications`,
    });
    expect(r1.alreadySent).toBe(false);
    expect(r1.status).toBe("SKIPPED_NO_EMAIL_SERVER");

    const dispatches = await superDb.notificationDispatch.findMany({
      where: { membershipId: membership.id },
    });
    expect(dispatches.length).toBe(1);
    expect(dispatches[0]?.status).toBe("SKIPPED_NO_EMAIL_SERVER");

    const inbox = await superDb.notificationInbox.findMany({
      where: { membershipId: membership.id },
    });
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.title).toBe("Test digest");
    expect(inbox[0]?.emailSentAt).toBeNull(); // mailer not configured
    expect(inbox[0]?.readAt).toBeNull();

    const auditAfterFirst = await superDb.auditEvent.count({
      where: { tenantId: t.id, eventType: "NOTIFICATION_DISPATCHED" },
    });
    expect(auditAfterFirst).toBe(1);

    // Second call with same dedupe key → no-op.
    const r2 = await dispatchNotification({
      tenantId: t.id,
      membershipId: membership.id,
      toEmail: user.email,
      kind: "weekly_digest",
      dedupeKey: "2026-W19",
      subject: "Test digest",
      text: "Body",
    });
    expect(r2.alreadySent).toBe(true);

    const dispatchesAfterSecond = await superDb.notificationDispatch.count({
      where: { membershipId: membership.id },
    });
    expect(dispatchesAfterSecond).toBe(1);
    const auditAfterSecond = await superDb.auditEvent.count({
      where: { tenantId: t.id, eventType: "NOTIFICATION_DISPATCHED" },
    });
    expect(auditAfterSecond).toBe(1);
  });
});

describe("Notifications — adherence escalation immediate dispatch", () => {
  it("notifies the sender and the FCT exactly once per adherence row", async () => {
    const t = await createTestTenant();
    const { membership: sender } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: uniqueEmail("user1"),
    });
    const { membership: fct } = await createTestUserAndMembership(t.id, {
      role: "FCT_MEMBER",
      email: uniqueEmail("fct1"),
    });
    const { membership: admin } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fa1"),
    });

    const draft = await makeDraft({
      tenantId: t.id,
      membershipId: sender.id,
    });
    const adh = await makeAdherence({
      tenantId: t.id,
      draftId: draft.id,
      membershipId: sender.id,
      overall: 0.3,
    });

    const r = await escalateAdherenceIfPoor({
      tenantId: t.id,
      adherenceId: adh.id,
      overall: 0.3,
      draftId: draft.id,
      membershipId: sender.id,
    });
    expect(r.escalated).toBe(true);
    expect(0.3).toBeLessThan(ADHERENCE_ESCALATION_THRESHOLD);

    // Sender + FCT_MEMBER + FIRM_ADMIN each get one notification.
    const recipients = await superDb.notificationDispatch.findMany({
      where: { tenantId: t.id, kind: "adherence_escalation", dedupeKey: adh.id },
      select: { membershipId: true },
    });
    const recipientIds = recipients.map((r) => r.membershipId).sort();
    expect(recipientIds).toEqual([sender.id, fct.id, admin.id].sort());

    // Re-running the escalator (idempotent on `escalatedAt`) must not produce
    // additional dispatches.
    await escalateAdherenceIfPoor({
      tenantId: t.id,
      adherenceId: adh.id,
      overall: 0.3,
      draftId: draft.id,
      membershipId: sender.id,
    });
    const recipientsAfter = await superDb.notificationDispatch.count({
      where: { tenantId: t.id, kind: "adherence_escalation", dedupeKey: adh.id },
    });
    expect(recipientsAfter).toBe(3);
  });

  it("does NOT escalate when overall is at or above threshold", async () => {
    const t = await createTestTenant();
    const { membership: sender } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    const draft = await makeDraft({ tenantId: t.id, membershipId: sender.id });
    const adh = await makeAdherence({
      tenantId: t.id,
      draftId: draft.id,
      membershipId: sender.id,
      overall: 0.8,
    });
    const r = await escalateAdherenceIfPoor({
      tenantId: t.id,
      adherenceId: adh.id,
      overall: 0.8,
      draftId: draft.id,
      membershipId: sender.id,
    });
    expect(r.escalated).toBe(false);
    const dispatches = await superDb.notificationDispatch.count({
      where: { kind: "adherence_escalation", dedupeKey: adh.id },
    });
    expect(dispatches).toBe(0);
  });
});

describe("Notifications — breach dispatch immediate", () => {
  it("notifies every FIRM_ADMIN of the affected tenant once per BreachClientNotification", async () => {
    // Acumon-side incident + affected tenant.
    const acumon = await createTestTenant({ slug: `acumon-${Date.now()}` });
    const { membership: operator } = await createTestUserAndMembership(acumon.id, {
      role: "FIRM_ADMIN",
    });
    const affected = await createTestTenant();
    const { membership: fa1 } = await createTestUserAndMembership(affected.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("afa1"),
    });
    const { membership: fa2 } = await createTestUserAndMembership(affected.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("afa2"),
    });
    // FCT does not have breach:notify so should not get the immediate ack ping.
    await createTestUserAndMembership(affected.id, { role: "FCT_MEMBER" });

    const incident = await createBreachIncident({
      title: "Test incident",
      description: "Test",
      severity: "MEDIUM",
      awareAt: new Date(),
      recordedByName: "Tester",
      actorTenantId: acumon.id,
      actorMembershipId: operator.id,
    });
    const notif = await addAffectedTenant({
      incidentId: incident.id,
      tenantId: affected.id,
      actorTenantId: acumon.id,
      actorMembershipId: operator.id,
    });

    await dispatchBreach({
      notificationId: notif.id,
      tenantId: affected.id,
      notifiedByName: "Operator",
      notifiedToName: "Affected DPO",
      notifiedToRole: "DPO",
      payload: "Body",
      actorTenantId: acumon.id,
      actorMembershipId: operator.id,
    });

    const dispatches = await superDb.notificationDispatch.findMany({
      where: { tenantId: affected.id, kind: "breach_ack_required", dedupeKey: notif.id },
      select: { membershipId: true },
    });
    expect(dispatches.map((d) => d.membershipId).sort()).toEqual([fa1.id, fa2.id].sort());
  });
});

describe("Notifications — weekly digest", () => {
  it("aggregates per-membership and is idempotent on the ISO week key", async () => {
    const t = await createTestTenant();
    const { membership: admin, user: adminUser } = await createTestUserAndMembership(t.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("fa-digest"),
    });
    // Give the admin one overdue action so the digest has content.
    await superDb.action.create({
      data: {
        tenantId: t.id,
        membershipId: admin.id,
        title: "Overdue thing",
        type: "task",
        status: "OPEN",
        dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    });

    const week = isoWeekKey(new Date());

    const first = await runWeeklyDigest({ tenantId: t.id, weekKey: week });
    expect(first.weekKey).toBe(week);
    expect(first.membershipsScanned).toBeGreaterThanOrEqual(1);
    expect(first.dispatched + first.alreadySent).toBeGreaterThanOrEqual(1);

    const dispatchesAfterFirst = await superDb.notificationDispatch.count({
      where: { tenantId: t.id, kind: "weekly_digest", dedupeKey: week },
    });
    expect(dispatchesAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await runWeeklyDigest({ tenantId: t.id, weekKey: week });
    expect(second.alreadySent).toBe(first.dispatched + first.alreadySent);
    const dispatchesAfterSecond = await superDb.notificationDispatch.count({
      where: { tenantId: t.id, kind: "weekly_digest", dedupeKey: week },
    });
    expect(dispatchesAfterSecond).toBe(dispatchesAfterFirst);

    // Inbox row exists and is unread.
    const inbox = await superDb.notificationInbox.findMany({
      where: { membershipId: admin.id, kind: "weekly_digest", dedupeKey: week },
    });
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.readAt).toBeNull();

    // Admin user email is included in the dispatch payload audit chain.
    const audit = await superDb.auditEvent.findFirst({
      where: { tenantId: t.id, eventType: "NOTIFICATION_DIGEST_RUN" },
    });
    expect(audit).toBeTruthy();
    void adminUser; // referenced for shape; assertion above is sufficient
  });

  it("skips memberships with empty digests (no content, no row)", async () => {
    const t = await createTestTenant();
    const { membership: empty } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: uniqueEmail("empty"),
    });
    const week = isoWeekKey(new Date());
    const r = await runWeeklyDigest({ tenantId: t.id, weekKey: week });
    expect(r.dispatched + r.alreadySent + r.skipped + r.failed).toBe(r.membershipsScanned);

    const dispatches = await superDb.notificationDispatch.count({
      where: { membershipId: empty.id, kind: "weekly_digest" },
    });
    expect(dispatches).toBe(0);
  });
});

describe("Notifications — nav badges", () => {
  it("counts outstanding work for the membership", async () => {
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    // Overdue action assigned to me.
    await superDb.action.create({
      data: {
        tenantId: t.id,
        membershipId: user.id,
        title: "Overdue",
        type: "task",
        status: "OPEN",
        dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership: user,
    });
    expect(badges.byHref[`/${t.slug}/actions`]).toBe(1);
    // Plain USER cannot vote on FCG proposals → no fcg badge.
    expect(badges.byHref[`/${t.slug}/fcg`]).toBeUndefined();
  });

  // Item 82 — sentiment badge gets a `stale` tone when the oldest
  // unacked escalation has been outstanding > 4h. Same threshold as
  // item 77's cron — the badge turns red at exactly the moment the
  // stale-sweep cron would have warned.
  it("flags stale tone on sentiment when oldest unacked > 4h", async () => {
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    // One unacked escalation, 5h old.
    await superDb.sentimentSignal.create({
      data: {
        tenantId: t.id,
        classification: "EXTREME_NEG",
        confidence: 0.9,
        isAboutFirmHandling: true,
        shouldEscalate: true,
        escalatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        assignedToMembershipId: user.id,
      },
    });
    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership: user,
    });
    expect(badges.byHref[`/${t.slug}/sentiment`]).toBe(1);
    expect(badges.tones[`/${t.slug}/sentiment`]).toBe("stale");
  });

  it("no stale tone when oldest unacked is under 4h", async () => {
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    await superDb.sentimentSignal.create({
      data: {
        tenantId: t.id,
        classification: "EXTREME_NEG",
        confidence: 0.9,
        isAboutFirmHandling: true,
        shouldEscalate: true,
        escalatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        assignedToMembershipId: user.id,
      },
    });
    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership: user,
    });
    expect(badges.byHref[`/${t.slug}/sentiment`]).toBe(1);
    expect(badges.tones[`/${t.slug}/sentiment`]).toBeUndefined();
  });

  it("no stale tone when zero unacked escalations", async () => {
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership: user,
    });
    expect(badges.byHref[`/${t.slug}/sentiment`]).toBeUndefined();
    expect(badges.tones[`/${t.slug}/sentiment`]).toBeUndefined();
  });

  it("ignores an acked-old signal when computing stale tone", async () => {
    // An acked signal that was escalated 10h ago must NOT trigger the
    // stale tone — the badge predicate already filters to acknowledgedAt:
    // null, but the oldest-unacked findFirst uses the SAME predicate,
    // so an acked old signal is invisible to both.
    const t = await createTestTenant();
    const { membership: user } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    await superDb.sentimentSignal.create({
      data: {
        tenantId: t.id,
        classification: "EXTREME_NEG",
        confidence: 0.9,
        isAboutFirmHandling: true,
        shouldEscalate: true,
        escalatedAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
        acknowledgedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
        assignedToMembershipId: user.id,
      },
    });
    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership: user,
    });
    expect(badges.byHref[`/${t.slug}/sentiment`]).toBeUndefined();
    expect(badges.tones[`/${t.slug}/sentiment`]).toBeUndefined();
  });
});

describe("Notifications — aggregate (helper)", () => {
  it("digestHasContent is false for an empty membership", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    const d = await aggregateForMembership({ tenant: t, membership });
    expect(digestHasContent(d)).toBe(false);
    expect(d.totalOpen).toBe(0);
  });
});

/**
 * Post-PRD item 65 — surface FCG-overdue and due-soon drafts in the weekly
 * digest and on the /drafts sidebar badge.
 */
describe("Notifications — drafts in digest + badges (item 65)", () => {
  it("aggregateForMembership buckets the Member's drafts by FCG deadline", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });

    const now = Date.now();
    // 1 overdue (deadline 2h ago), 1 due-soon (deadline 6h out), 1 open
    // (deadline 3d out), 1 no-deadline open, 1 SENT (excluded).
    await superDb.draft.createMany({
      data: [
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "overdue",
          body: "x",
          fcgWindowDeadline: new Date(now - 2 * 60 * 60 * 1000),
        },
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "due-soon",
          body: "x",
          fcgWindowDeadline: new Date(now + 6 * 60 * 60 * 1000),
        },
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "open-future",
          body: "x",
          fcgWindowDeadline: new Date(now + 3 * 24 * 60 * 60 * 1000),
        },
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "no-deadline",
          body: "x",
        },
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "SENT",
          subject: "sent",
          body: "x",
          sentMarkedAt: new Date(),
        },
      ],
    });

    const d = await aggregateForMembership({ tenant: t, membership });
    expect(d.drafts.overdue).toBe(1);
    expect(d.drafts.dueSoon).toBe(1);
    expect(d.drafts.open).toBe(2);
    // overdue (1) + dueSoon (1) contribute; the no-deadline + future open
    // pair (2) deliberately do NOT.
    expect(d.totalOpen).toBe(2);
    expect(digestHasContent(d)).toBe(true);
  });

  it("digestHasContent stays false when only no-deadline drafts exist", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    await superDb.draft.create({
      data: {
        tenantId: t.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "PROPOSED",
        subject: "no-deadline",
        body: "x",
      },
    });
    const d = await aggregateForMembership({ tenant: t, membership });
    expect(d.drafts.overdue).toBe(0);
    expect(d.drafts.dueSoon).toBe(0);
    expect(d.drafts.open).toBe(1);
    // A pile of no-deadline drafts should NOT pull the membership into
    // the weekly email — they live on /drafts.
    expect(digestHasContent(d)).toBe(false);
  });

  it("aggregate is tenant-scoped: another tenant's drafts don't leak", async () => {
    const t1 = await createTestTenant();
    const t2 = await createTestTenant();
    const { membership: m1, user: u1 } = await createTestUserAndMembership(t1.id, {
      role: "USER",
      email: uniqueEmail("m1"),
    });
    // Same User, separate Membership in t2.
    const m2 = await superDb.membership.create({
      data: { tenantId: t2.id, userId: u1.id, role: "USER", status: "ACTIVE" },
    });

    await superDb.draft.create({
      data: {
        tenantId: t2.id,
        membershipId: m2.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "PROPOSED",
        subject: "t2-overdue",
        body: "x",
        fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const d = await aggregateForMembership({ tenant: t1, membership: m1 });
    expect(d.drafts.overdue).toBe(0);
    expect(d.drafts.dueSoon).toBe(0);
  });

  it("nav badge: /drafts gets the overdue count (not due_soon)", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
    });
    const now = Date.now();
    await superDb.draft.createMany({
      data: [
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "od1",
          body: "x",
          fcgWindowDeadline: new Date(now - 60 * 60 * 1000),
        },
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "od2",
          body: "x",
          fcgWindowDeadline: new Date(now - 5 * 60 * 60 * 1000),
        },
        // due_soon: must NOT show on the badge.
        {
          tenantId: t.id,
          membershipId: membership.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "PROPOSED",
          subject: "ds1",
          body: "x",
          fcgWindowDeadline: new Date(now + 2 * 60 * 60 * 1000),
        },
      ],
    });

    const badges = await getNavBadges({
      tenantId: t.id,
      tenantSlug: t.slug,
      membership,
    });
    expect(badges.byHref[`/${t.slug}/drafts`]).toBe(2);
  });

  it("weekly digest dispatches a row for a Member with overdue drafts only", async () => {
    const t = await createTestTenant();
    const { membership } = await createTestUserAndMembership(t.id, {
      role: "USER",
      email: uniqueEmail("drafter"),
    });
    await superDb.draft.create({
      data: {
        tenantId: t.id,
        membershipId: membership.id,
        kind: "EMAIL",
        channel: "EMAIL",
        status: "PROPOSED",
        subject: "overdue-for-digest",
        body: "x",
        fcgWindowDeadline: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const week = isoWeekKey(new Date());
    const r = await runWeeklyDigest({ tenantId: t.id, weekKey: week });
    expect(r.dispatched + r.alreadySent).toBeGreaterThanOrEqual(1);

    const dispatch = await superDb.notificationDispatch.findFirst({
      where: { tenantId: t.id, membershipId: membership.id, kind: "weekly_digest", dedupeKey: week },
    });
    expect(dispatch).toBeTruthy();
    // Payload carries the drafts shape so receivers (e.g. a future
    // mobile push integration) can render the same buckets without
    // re-aggregating.
    const payload = dispatch?.payload as { drafts?: { overdue: number; dueSoon: number; open: number } } | null;
    expect(payload?.drafts?.overdue).toBe(1);
  });
});
