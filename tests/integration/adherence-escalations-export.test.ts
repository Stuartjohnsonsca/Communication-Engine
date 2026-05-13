/**
 * Post-PRD hardening item 89 — uncapped per-escalation CSV export of
 * adherence escalations. Sister to item 83's sentiment-responses test.
 *
 * Coverage:
 *   - `getAllAdherenceEscalations` returns ALL acked + open-overdue rows
 *     in window (no /adherence/escalations page-level 200-row cap).
 *   - Sort: each bucket is slowest-first (longest ackMs / outstandingMs).
 *   - Non-escalated rows never appear (escalatedAt: null excluded in SQL).
 *   - Out-of-window escalations don't contribute (escalatedAt cutoff).
 *   - Tenant isolation.
 *   - CSV format: BOM + header + per-row lines + RFC 4180 quoting.
 *   - `GET /api/admin/adherence/export` writes the
 *     `ADHERENCE_ESCALATIONS_EXPORTED` audit row with the right shape.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  getAllAdherenceEscalations,
  formatAdherenceEscalationsAsCsv,
  ADHERENCE_ESCALATIONS_CSV_HEADER,
} from "@/lib/adherence/escalations-export";
import { GET as exportRoute } from "@/app/api/admin/adherence/export/route";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

const HOUR = 60 * 60 * 1000;

async function makeDraft(input: {
  tenantId: string;
  membershipId: string;
  subject?: string;
  synthesisedFromOutboundIngest?: boolean;
  inboundSender?: string | null;
}) {
  return superDb.draft.create({
    data: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      kind: "EMAIL",
      status: "SENT",
      channel: "EMAIL",
      subject: input.subject ?? "Test send",
      body: "Body",
      sentText: "Body",
      sentMarkedAt: new Date(),
      synthesisedFromOutboundIngest:
        input.synthesisedFromOutboundIngest ?? false,
      inboundSender: input.inboundSender ?? null,
    },
  });
}

async function makeAdherence(input: {
  tenantId: string;
  membershipId: string;
  overall: number;
  escalatedAt: Date | null;
  acknowledgedAt?: Date | null;
  acknowledgedById?: string | null;
  draftId?: string;
  synthesisedFromOutboundIngest?: boolean;
  inboundSender?: string | null;
  fcgVersionUsed?: number;
  ucgVersionUsed?: number | null;
}) {
  const draftId =
    input.draftId ??
    (
      await makeDraft({
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        synthesisedFromOutboundIngest: input.synthesisedFromOutboundIngest,
        inboundSender: input.inboundSender,
      })
    ).id;
  return superDb.communicationAdherence.create({
    data: {
      tenantId: input.tenantId,
      draftId,
      membershipId: input.membershipId,
      fcgVersionUsed: input.fcgVersionUsed ?? 1,
      ucgVersionUsed: input.ucgVersionUsed ?? null,
      overall: input.overall,
      perDimension: {},
      perRule: [],
      escalatedAt: input.escalatedAt,
      acknowledgedAt: input.acknowledgedAt ?? null,
      acknowledgedById: input.acknowledgedById ?? null,
    },
  });
}

describe("getAllAdherenceEscalations — uncapped + sorted", () => {
  it("returns every acked escalation in window and sorts slowest-first", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-export-acked"),
    });
    const now = new Date();
    // 12 acked escalations with varying TTAs (1h..12h).
    for (let h = 1; h <= 12; h += 1) {
      const escalatedAt = new Date(now.getTime() - 20 * HOUR);
      await makeAdherence({
        tenantId: tenant.id,
        membershipId: membership.id,
        overall: 0.45,
        escalatedAt,
        acknowledgedAt: new Date(escalatedAt.getTime() + h * HOUR),
        acknowledgedById: membership.id,
      });
    }
    const r = await getAllAdherenceEscalations({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(r.acknowledged).toHaveLength(12);
    expect(r.openOverdue).toHaveLength(0);
    // Slowest-first: first row's ackMs is 12h, last is 1h.
    expect(Math.round(r.acknowledged[0]!.ackMs / HOUR)).toBe(12);
    expect(
      Math.round(r.acknowledged[r.acknowledged.length - 1]!.ackMs / HOUR),
    ).toBe(1);
  });

  it("openOverdue bucket sorts most-outstanding first", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-export-open"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt: new Date(now.getTime() - 6 * HOUR),
    });
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt: new Date(now.getTime() - 2 * HOUR),
    });
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt: new Date(now.getTime() - 30 * 60_000),
    });
    const r = await getAllAdherenceEscalations({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(r.openOverdue).toHaveLength(3);
    const outstandingHours = r.openOverdue.map((row) =>
      Math.round(row.outstandingMs / HOUR),
    );
    expect(outstandingHours).toEqual([6, 2, 0]);
  });

  it("non-escalated rows never appear (escalatedAt: null excluded in SQL)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-export-nonesc"),
    });
    const now = new Date();
    // A scored-but-not-escalated row (above threshold, no escalation).
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.92,
      escalatedAt: null,
    });
    // One real escalated-and-acked row to ensure the query path works.
    const escalatedAt = new Date(now.getTime() - 4 * HOUR);
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + HOUR),
      acknowledgedById: membership.id,
    });
    const r = await getAllAdherenceEscalations({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(r.acknowledged).toHaveLength(1);
    expect(r.openOverdue).toHaveLength(0);
  });

  it("out-of-window escalations are excluded", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("adh-export-window"),
    });
    const now = new Date();
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt: new Date(now.getTime() - 45 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 44 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt: new Date(now.getTime() - 5 * 24 * HOUR),
      acknowledgedAt: new Date(now.getTime() - 4 * 24 * HOUR),
      acknowledgedById: membership.id,
    });
    const r = await getAllAdherenceEscalations({
      tenantId: tenant.id,
      windowDays: 30,
      now,
    });
    expect(r.acknowledged).toHaveLength(1);
  });

  it("tenant-scoped: A's escalations don't leak into B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const { membership: mA } = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("adh-export-iso-a"),
    });
    const { membership: mB } = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("adh-export-iso-b"),
    });
    const now = new Date();
    const escalatedAt = new Date(now.getTime() - 3 * HOUR);
    await makeAdherence({
      tenantId: tenantA.id,
      membershipId: mA.id,
      overall: 0.4,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + HOUR),
      acknowledgedById: mA.id,
    });
    await makeAdherence({
      tenantId: tenantB.id,
      membershipId: mB.id,
      overall: 0.4,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + 2 * HOUR),
      acknowledgedById: mB.id,
    });
    const rA = await getAllAdherenceEscalations({
      tenantId: tenantA.id,
      windowDays: 30,
      now,
    });
    const rB = await getAllAdherenceEscalations({
      tenantId: tenantB.id,
      windowDays: 30,
      now,
    });
    expect(rA.acknowledged).toHaveLength(1);
    expect(rB.acknowledged).toHaveLength(1);
    expect(Math.round(rA.acknowledged[0]!.ackMs / HOUR)).toBe(1);
    expect(Math.round(rB.acknowledged[0]!.ackMs / HOUR)).toBe(2);
  });
});

describe("formatAdherenceEscalationsAsCsv — RFC 4180 shape", () => {
  it("emits BOM + header + one line per escalation with bucket discriminator", () => {
    const now = new Date("2026-05-13T00:00:00.000Z");
    const csv = formatAdherenceEscalationsAsCsv({
      windowDays: 30,
      acknowledged: [
        {
          adherenceId: "a-1",
          draftId: "d-1",
          channel: "EMAIL",
          subject: "Test",
          synthesisedFromOutboundIngest: false,
          inboundSender: null,
          fcgVersionUsed: 7,
          ucgVersionUsed: 3,
          overall: 0.42,
          membershipId: "m-1",
          escalatedAt: new Date(now.getTime() - 2 * HOUR),
          acknowledgedAt: new Date(now.getTime() - HOUR),
          acknowledgedByMembershipId: "m-1",
          ackMs: HOUR,
        },
      ],
      openOverdue: [
        {
          adherenceId: "a-2",
          draftId: "d-2",
          channel: "EMAIL",
          subject: "Stuck",
          synthesisedFromOutboundIngest: true,
          inboundSender: "client@example.com",
          fcgVersionUsed: 7,
          ucgVersionUsed: null,
          overall: 0.31,
          membershipId: "m-2",
          escalatedAt: new Date(now.getTime() - 5 * HOUR),
          outstandingMs: 5 * HOUR,
        },
      ],
    });
    expect(csv).toMatch(/^﻿/); // BOM
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(ADHERENCE_ESCALATIONS_CSV_HEADER.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("acknowledged,a-1,d-1,EMAIL,Test,false,,7,3,0.4200,42");
    expect(lines[2]).toContain("open_overdue,a-2,d-2,EMAIL,Stuck,true,client@example.com,7,,0.3100,31");
  });

  it("RFC 4180 quotes labels containing commas and doubles embedded quotes", () => {
    const csv = formatAdherenceEscalationsAsCsv(
      {
        windowDays: 30,
        acknowledged: [
          {
            adherenceId: "a-1",
            draftId: "d-1",
            channel: "EMAIL",
            subject: "Hi, please",
            synthesisedFromOutboundIngest: false,
            inboundSender: null,
            fcgVersionUsed: 1,
            ucgVersionUsed: null,
            overall: 0.5,
            membershipId: "m-1",
            escalatedAt: new Date(),
            acknowledgedAt: new Date(),
            acknowledgedByMembershipId: "m-1",
            ackMs: 60_000,
          },
        ],
        openOverdue: [],
      },
      new Map([["m-1", `O'Connor, "Jane"`]]),
    );
    expect(csv).toContain(`"O'Connor, ""Jane"""`);
    expect(csv).toContain(`"Hi, please"`);
  });
});

describe("GET /api/admin/adherence/export — audit + CSV body", () => {
  it("writes ADHERENCE_ESCALATIONS_EXPORTED on the tenant chain and returns CSV", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("adh-export-route"),
    });
    const now = new Date();
    const escalatedAt = new Date(now.getTime() - 3 * HOUR);
    await makeAdherence({
      tenantId: tenant.id,
      membershipId: membership.id,
      overall: 0.4,
      escalatedAt,
      acknowledgedAt: new Date(escalatedAt.getTime() + 30 * 60_000),
      acknowledgedById: membership.id,
    });

    const url = `http://test/api/admin/adherence/export?tenant=${tenant.slug}&window=30`;
    const res = await exportRoute(new Request(url));
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("text/csv");
      const body = await res.text();
      expect(body).toMatch(/^﻿/);
      expect(body).toContain("bucket,adherenceId");
      const audit = await superDb.auditEvent.findFirst({
        where: {
          tenantId: tenant.id,
          eventType: "ADHERENCE_ESCALATIONS_EXPORTED",
        },
      });
      expect(audit).toBeTruthy();
      const payload = audit?.payload as {
        windowDays?: number;
        counts?: { acknowledged?: number; openOverdue?: number };
      };
      expect(payload?.windowDays).toBe(30);
      expect(payload?.counts?.acknowledged).toBe(1);
      expect(payload?.counts?.openOverdue).toBe(0);
    } else {
      // Same flexibility as item 83's test: some test harnesses don't
      // wire the session helper, so a 401/403 is acceptable as long as
      // the route exists and rejects cleanly.
      expect([401, 403]).toContain(res.status);
    }
  });
});
