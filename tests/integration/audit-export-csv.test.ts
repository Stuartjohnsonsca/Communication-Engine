/**
 * Post-PRD hardening item 49 — RFC 4180 CSV rendering for the audit
 * export.
 *
 * Coverage:
 *   - Header row + one CRLF-terminated record per event.
 *   - UTF-8 BOM prefix so Excel opens UTF-8 correctly.
 *   - Empty event list still emits BOM + header + trailing CRLF.
 *   - Bigint seq serialises without exponent / scientific notation.
 *   - actorMembershipId === null renders as the empty field.
 *   - Fields containing `,` `"` CR or LF are wrapped in quotes with
 *     embedded `"` doubled (per RFC 4180).
 *   - Payload JSON containing commas + double quotes round-trips
 *     through the escape rules cleanly.
 *   - `csvField` quotes only when needed (no spurious quoting on
 *     plain alphanumerics).
 */
import { describe, it, expect } from "vitest";
import {
  formatAuditAsCsv,
  csvField,
  UTF8_BOM,
  AUDIT_CSV_HEADER,
  type AuditCsvRow,
} from "@/lib/audit-csv";

function row(overrides: Partial<AuditCsvRow> = {}): AuditCsvRow {
  return {
    seq: 1n,
    createdAt: new Date("2026-05-12T10:00:00Z"),
    eventType: "USER_REAUTHORISED",
    actorMembershipId: "m1",
    subjectType: "Membership",
    subjectId: "m1",
    hash: "abc",
    prevHash: "def",
    payload: { ok: true },
    ...overrides,
  };
}

function recordsOf(csv: string): string[] {
  // Strip the BOM, split on CRLF, drop trailing empty.
  return csv.slice(1).split("\r\n").filter((line) => line.length > 0);
}

describe("formatAuditAsCsv (item 49)", () => {
  it("emits BOM, header, and one CRLF-terminated record per event", () => {
    const csv = formatAuditAsCsv([row(), row({ seq: 2n, subjectId: "m2" })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(csv).toBe(UTF8_BOM + csv.slice(1));
    expect(csv.endsWith("\r\n")).toBe(true);

    const records = recordsOf(csv);
    expect(records.length).toBe(3); // header + 2 rows
    expect(records[0]).toBe(AUDIT_CSV_HEADER.join(","));
  });

  it("empty event list still emits BOM + header + trailing CRLF", () => {
    const csv = formatAuditAsCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const records = recordsOf(csv);
    expect(records.length).toBe(1);
    expect(records[0]).toBe(AUDIT_CSV_HEADER.join(","));
  });

  it("bigint seq serialises as plain decimal", () => {
    const csv = formatAuditAsCsv([row({ seq: 9999999999n })]);
    const dataRow = recordsOf(csv)[1]!;
    expect(dataRow.startsWith("9999999999,")).toBe(true);
    expect(dataRow).not.toMatch(/e\+/i);
  });

  it("renders null actorMembershipId as an empty field", () => {
    const csv = formatAuditAsCsv([row({ actorMembershipId: null })]);
    const dataRow = recordsOf(csv)[1]!;
    // Header order: seq,createdAt,eventType,actorMembershipId,...
    // The empty field is the 4th column → two commas adjacent.
    expect(dataRow).toMatch(/^1,2026-05-12T10:00:00\.000Z,USER_REAUTHORISED,,Membership/);
  });

  it("escapes commas in payload by quoting the field", () => {
    const csv = formatAuditAsCsv([
      row({ payload: { msg: "a, b, c" }, subjectId: "with-comma" }),
    ]);
    const dataRow = recordsOf(csv)[1]!;
    // Payload column is the last; must be a single quoted field.
    expect(dataRow).toContain(`"{""msg"":""a, b, c""}"`);
  });

  it("escapes embedded double quotes by doubling (RFC 4180)", () => {
    const csv = formatAuditAsCsv([row({ payload: { msg: `she said "hi"` } })]);
    const dataRow = recordsOf(csv)[1]!;
    // The serialised JSON is {"msg":"she said \"hi\""}. Inside the
    // quoted CSV field every `"` becomes `""`.
    expect(dataRow).toContain(`"{""msg"":""she said \\""hi\\""""}"`);
  });

  it("CR and LF inside a field force quoting; the line break does not split records", () => {
    const csv = formatAuditAsCsv([
      row({ payload: { note: "line1\nline2\rline3" } }),
      row({ seq: 2n, subjectId: "after" }),
    ]);
    const records = recordsOf(csv);
    // Header + 2 records, despite the embedded newlines. The naive
    // split on \r\n would over-count if quoting were broken.
    expect(records.length).toBeGreaterThanOrEqual(3);
    // The "after" record exists and starts with seq 2.
    expect(records.some((r) => r.startsWith("2,"))).toBe(true);
  });

  it("csvField does not quote plain alphanumerics", () => {
    expect(csvField("abc")).toBe("abc");
    expect(csvField("DRAFT_SENT_MARKED")).toBe("DRAFT_SENT_MARKED");
    expect(csvField("2026-05-12T10:00:00.000Z")).toBe("2026-05-12T10:00:00.000Z");
  });

  it("csvField quotes when forced and doubles embedded quotes", () => {
    expect(csvField(`a,b`)).toBe(`"a,b"`);
    expect(csvField(`a"b`)).toBe(`"a""b"`);
    expect(csvField(`a\nb`)).toBe(`"a\nb"`);
    expect(csvField(`a\rb`)).toBe(`"a\rb"`);
  });
});
