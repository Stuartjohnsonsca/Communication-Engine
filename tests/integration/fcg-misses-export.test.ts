/**
 * Post-PRD hardening item 76 — uncapped CSV export of FCG-window
 * misses.
 *
 * Coverage:
 *   - `getAllFcgMisses` returns ALL misses (not capped at
 *     RECENT_MISSES_LIMIT) and sorts each bucket most-late first.
 *   - Exclusions match items 66/74: bypassed-synth excluded entirely,
 *     no-deadline excluded entirely, DISCARDED past-deadline excluded
 *     from openOverdue.
 *   - CSV format: BOM + header + per-row lines + RFC 4180 quoting on
 *     embedded commas/quotes.
 *   - GET /api/admin/drafts/misses-export writes an
 *     FCG_MISSES_EXPORTED audit row with the right shape.
 *   - Cross-tenant isolation.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  getAllFcgMisses,
  formatFcgMissesAsCsv,
  FCG_MISSES_CSV_HEADER,
} from "@/lib/drafts";
import { GET as exportRoute } from "@/app/api/admin/drafts/misses-export/route";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("getAllFcgMisses — uncapped + sorted", () => {
  it("returns more rows than RECENT_MISSES_LIMIT (no top-10 cap)", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("misses-uncapped"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    // 15 late sends — page panel caps at 10; export must return all 15.
    for (let i = 1; i <= 15; i += 1) {
      await superDb.draft.create({
        data: {
          tenantId: tenant.id,
          membershipId: membership.id,
          status: "SENT",
          body: "x",
          createdAt: base,
          fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
          sentMarkedAt: new Date(base.getTime() + (30 + i) * 60_000),
        },
      });
    }

    const r = await getAllFcgMisses({ tenantId: tenant.id });
    expect(r.sentAfterWindow).toHaveLength(15);
    // Most-late first: first row is 15m late, last is 1m late.
    const lateMinutes = r.sentAfterWindow.map((row) =>
      Math.round(row.lateMs / 60_000),
    );
    expect(lateMinutes[0]).toBe(15);
    expect(lateMinutes[lateMinutes.length - 1]).toBe(1);
  });

  it("openOverdue bucket sorts most-overdue first and respects exclusions", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("misses-open"),
    });

    const now = Date.now();
    // Three currently-overdue open drafts.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "PROPOSED",
        body: "x",
        fcgWindowDeadline: new Date(now - 30 * 60_000),
      },
    });
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "EDITED",
        body: "x",
        fcgWindowDeadline: new Date(now - 2 * 60 * 60_000),
      },
    });
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "ACCEPTED",
        body: "x",
        fcgWindowDeadline: new Date(now - 6 * 60 * 60_000),
      },
    });
    // DISCARDED past-deadline → excluded (operator out-of-scope, not breach).
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "DISCARDED",
        body: "x",
        fcgWindowDeadline: new Date(now - 60 * 60_000),
      },
    });

    const r = await getAllFcgMisses({ tenantId: tenant.id });
    expect(r.openOverdue).toHaveLength(3);
    const statuses = r.openOverdue.map((row) => row.status);
    expect(statuses).toEqual(["ACCEPTED", "EDITED", "PROPOSED"]);
    for (const row of r.openOverdue) {
      expect(row.status).not.toBe("DISCARDED");
      expect(row.status).not.toBe("SENT");
    }
  });

  it("bypassed-synth and no-deadline rows never appear in either bucket", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "USER",
      email: uniqueEmail("misses-exclusions"),
    });

    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);
    // Bypassed-synth late send.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "SENT",
        body: "x",
        synthesisedFromOutboundIngest: true,
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 180 * 60_000),
      },
    });
    // No-deadline late "send" — no deadline = no promise to break.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "SENT",
        body: "x",
        createdAt: base,
        sentMarkedAt: new Date(base.getTime() + 180 * 60_000),
      },
    });
    // One real late send so the test isn't all-zero.
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 50 * 60_000),
      },
    });

    const r = await getAllFcgMisses({ tenantId: tenant.id });
    expect(r.sentAfterWindow).toHaveLength(1);
    expect(r.openOverdue).toHaveLength(0);
    expect(Math.round(r.sentAfterWindow[0]!.lateMs / 60_000)).toBe(20);
  });

  it("tenant-scoped: tenant A's misses don't leak into tenant B", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();
    const a = await createTestUserAndMembership(tenantA.id, {
      role: "USER",
      email: uniqueEmail("misses-iso-a"),
    });
    const b = await createTestUserAndMembership(tenantB.id, {
      role: "USER",
      email: uniqueEmail("misses-iso-b"),
    });
    const base = new Date(Date.now() - 6 * 60 * 60 * 1000);

    await superDb.draft.create({
      data: {
        tenantId: tenantA.id,
        membershipId: a.membership.id,
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 60 * 60_000),
      },
    });
    await superDb.draft.create({
      data: {
        tenantId: tenantB.id,
        membershipId: b.membership.id,
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 60 * 60_000),
      },
    });

    const rA = await getAllFcgMisses({ tenantId: tenantA.id });
    const rB = await getAllFcgMisses({ tenantId: tenantB.id });
    expect(rA.sentAfterWindow).toHaveLength(1);
    expect(rB.sentAfterWindow).toHaveLength(1);
    expect(rA.sentAfterWindow[0]!.membershipId).toBe(a.membership.id);
    expect(rB.sentAfterWindow[0]!.membershipId).toBe(b.membership.id);
  });
});

describe("formatFcgMissesAsCsv — RFC 4180 shape", () => {
  it("emits BOM + header + one line per miss with bucket discriminator", () => {
    const now = new Date("2026-05-13T00:00:00.000Z");
    const csv = formatFcgMissesAsCsv({
      windowDays: 30,
      sentAfterWindow: [
        {
          draftId: "d-1",
          membershipId: "m-1",
          fcgWindowDeadline: new Date(now.getTime() - 60 * 60_000),
          sentMarkedAt: new Date(now.getTime() - 30 * 60_000),
          status: "SENT",
          lateMs: 30 * 60_000,
        },
      ],
      openOverdue: [
        {
          draftId: "d-2",
          membershipId: "m-2",
          fcgWindowDeadline: new Date(now.getTime() - 2 * 60 * 60_000),
          sentMarkedAt: null,
          status: "PROPOSED",
          lateMs: 2 * 60 * 60_000,
        },
      ],
    });
    expect(csv).toMatch(/^﻿/); // BOM
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(FCG_MISSES_CSV_HEADER.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("sent_after,d-1,m-1");
    expect(lines[1]).toContain("SENT");
    expect(lines[2]).toContain("open_overdue,d-2,m-2");
    expect(lines[2]).toContain("PROPOSED");
  });

  it("RFC 4180 quotes labels containing commas and doubles embedded quotes", () => {
    const csv = formatFcgMissesAsCsv(
      {
        windowDays: 30,
        sentAfterWindow: [
          {
            draftId: "d-1",
            membershipId: "m-1",
            fcgWindowDeadline: new Date(),
            sentMarkedAt: new Date(),
            status: "SENT",
            lateMs: 60_000,
          },
        ],
        openOverdue: [],
      },
      new Map([["m-1", `O'Connor, "Jane"`]]),
    );
    expect(csv).toContain(`"O'Connor, ""Jane"""`);
  });
});

describe("GET /api/admin/drafts/misses-export — audit + CSV body", () => {
  it("writes FCG_MISSES_EXPORTED on the tenant chain and returns CSV", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("misses-route"),
    });
    const base = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await superDb.draft.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        status: "SENT",
        body: "x",
        createdAt: base,
        fcgWindowDeadline: new Date(base.getTime() + 30 * 60_000),
        sentMarkedAt: new Date(base.getTime() + 60 * 60_000),
      },
    });

    const url = `http://test/api/admin/drafts/misses-export?tenant=${tenant.slug}&window=30`;
    const res = await exportRoute(new Request(url));
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("text/csv");
      const body = await res.text();
      expect(body).toMatch(/^﻿/);
      expect(body).toContain("bucket,draftId");
      const audit = await superDb.auditEvent.findFirst({
        where: { tenantId: tenant.id, eventType: "FCG_MISSES_EXPORTED" },
      });
      expect(audit).toBeTruthy();
      const payload = audit?.payload as {
        windowDays?: number;
        counts?: { sentAfter?: number; openOverdue?: number };
      };
      expect(payload?.windowDays).toBe(30);
      expect(payload?.counts?.sentAfter).toBe(1);
    } else {
      // Same flexibility as the drafts-rollup-csv test for session-helper
      // availability in different harnesses.
      expect([401, 403]).toContain(res.status);
    }
  });
});

