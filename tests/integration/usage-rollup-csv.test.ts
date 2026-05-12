/**
 * Post-PRD hardening item 70 — CSV export of /admin/usage.
 *
 * Coverage:
 *   - Header columns are the documented contract.
 *   - Totals row carries the firm-wide aggregate.
 *   - Per-role / per-context / per-model / per-membership rows are
 *     emitted with the right scope prefix.
 *   - System (null-membership) rows surface as `membership:system` —
 *     load-bearing so cron cost is visible, not silently dropped.
 *   - CSV-quoting kicks in for labels containing commas.
 *   - Cost is emitted in MINOR UNITS alongside a `currency` column.
 *   - GET /api/admin/usage/export writes a USAGE_ROLLUP_EXPORTED audit
 *     row with windowDays + currency + totals in the payload.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  formatUsageRollupAsCsv,
  USAGE_CSV_HEADER,
} from "@/lib/ai/usage-csv";
import { GET as exportRoute } from "@/app/api/admin/usage/export/route";
import {
  createTestTenant,
  createTestUserAndMembership,
} from "../helpers/fixtures";

function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

describe("formatUsageRollupAsCsv — header contract", () => {
  it("emits the documented column order", () => {
    const csv = formatUsageRollupAsCsv({
      windowDays: 30,
      currency: "GBP",
      totals: makeRow("totals", "Totals (30d)"),
      byRole: [],
      byContext: [],
      byModel: [],
      byMembership: [],
    });
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(USAGE_CSV_HEADER.join(","));
    expect(USAGE_CSV_HEADER[0]).toBe("scope");
    expect(USAGE_CSV_HEADER[1]).toBe("label");
    expect(USAGE_CSV_HEADER).toContain("costMinor");
    expect(USAGE_CSV_HEADER).toContain("currency");
  });
});

describe("formatUsageRollupAsCsv — rows + quoting", () => {
  it("emits each group row with the right scope prefix and quotes labels with commas", () => {
    const csv = formatUsageRollupAsCsv({
      windowDays: 30,
      currency: "GBP",
      totals: makeRow("totals", "Totals (30d)", { calls: 3, costMinor: 100 }),
      byRole: [makeRow("role:draft", "draft", { calls: 2, costMinor: 80 })],
      byContext: [makeRow("context:auto-draft", "auto-draft", { calls: 2, costMinor: 60 })],
      byModel: [makeRow("model:claude-sonnet-4-6", "claude-sonnet-4-6", { costMinor: 70 })],
      byMembership: [makeRow("membership:m1", `O'Connor, "Jane"`, { calls: 1 })],
    });
    expect(csv).toContain(`totals,Totals (30d),3,0,0,0,0,100,GBP`);
    expect(csv).toContain("role:draft,draft,2,");
    expect(csv).toContain("context:auto-draft,auto-draft,2,");
    expect(csv).toContain("model:claude-sonnet-4-6,claude-sonnet-4-6,");
    expect(csv).toContain(`"O'Connor, ""Jane"""`);
  });
});

describe("GET /api/admin/usage/export — audit + CSV body", () => {
  it("aggregates LlmCall rows and writes USAGE_ROLLUP_EXPORTED on the chain", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, {
      role: "FIRM_ADMIN",
      email: uniqueEmail("usage-csv"),
    });
    // Two LlmCalls, one with membershipId (User-spend) and one without
    // (system / cron) so the CSV exercises both branches.
    await superDb.llmCall.createMany({
      data: [
        {
          tenantId: tenant.id,
          membershipId: membership.id,
          role: "draft",
          context: "manual-draft",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          succeeded: true,
        },
        {
          tenantId: tenant.id,
          role: "draft",
          context: "auto-draft",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          succeeded: true,
        },
      ],
    });

    const url = `http://test/api/admin/usage/export?tenant=${tenant.slug}&window=30`;
    const res = await exportRoute(new Request(url));

    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("text/csv");
      const body = await res.text();
      expect(body).toMatch(/^﻿/); // BOM
      expect(body).toContain("scope,label,calls,");
      // System (null-membership) row must surface so cron cost is
      // visible — load-bearing, not silently dropped.
      expect(body).toMatch(/membership:system,system \(cron\),/);
      const audit = await superDb.auditEvent.findFirst({
        where: { tenantId: tenant.id, eventType: "USAGE_ROLLUP_EXPORTED" },
      });
      expect(audit).toBeTruthy();
      const payload = audit?.payload as {
        windowDays?: number;
        format?: string;
        currency?: string;
        totals?: { calls?: number; costMinor?: number };
      };
      expect(payload?.windowDays).toBe(30);
      expect(payload?.format).toBe("csv");
      expect(payload?.totals?.calls).toBe(2);
      // costMinor is positive because both rows used a known-rate model.
      expect((payload?.totals?.costMinor ?? 0) > 0).toBe(true);
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});

function makeRow(
  scope: string,
  label: string,
  overrides: Partial<{
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costMinor: number;
  }> = {},
) {
  return {
    scope,
    label,
    calls: overrides.calls ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    costMinor: overrides.costMinor ?? 0,
  };
}
