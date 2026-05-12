/**
 * Post-PRD hardening item 70 — CSV export of /admin/usage.
 *
 * Pairs with item 68 (CSV export of /admin/drafts): finance and
 * procurement need the cost rollup as a spreadsheet for board /
 * partner reporting, not as an on-page table.
 *
 * Same posture as items 49 and 68:
 *   - RFC 4180 line endings (CRLF) + trailing terminator
 *   - UTF-8 BOM prefix so Excel opens it correctly
 *   - Single wide table with a `scope` discriminator column so a
 *     reviewer can pivot in a spreadsheet without parsing nested
 *     sections (totals / role:<r> / context:<c> / model:<m> /
 *     membership:<id>)
 *   - Cost emitted in MINOR UNITS (pence) + a currency column —
 *     unambiguous, no float-precision games on the way through CSV.
 *     The consumer divides by 100 if they want major units.
 *
 * Pure function in its own module so the route handler and tests
 * can both exercise it without spinning up NextAuth.
 */

export const UTF8_BOM = "﻿";

export const USAGE_CSV_HEADER = [
  "scope",
  "label",
  "calls",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "costMinor",
  "currency",
] as const;

export type UsageCsvRow = {
  scope: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMinor: number;
};

export type UsageRollupCsvInput = {
  windowDays: number;
  currency: string;
  totals: UsageCsvRow;
  byRole: ReadonlyArray<UsageCsvRow>;
  byContext: ReadonlyArray<UsageCsvRow>;
  byModel: ReadonlyArray<UsageCsvRow>;
  byMembership: ReadonlyArray<UsageCsvRow>;
};

export function formatUsageRollupAsCsv(input: UsageRollupCsvInput): string {
  const lines: string[] = [USAGE_CSV_HEADER.join(",")];

  // Totals row first so spreadsheet readers see the aggregate at the
  // top. The window stamp goes in the label so a downloaded file is
  // self-describing without filename inspection.
  lines.push(
    csvRowFields({ ...input.totals, label: `Totals (${input.windowDays}d)` }, input.currency),
  );
  for (const r of input.byRole) lines.push(csvRowFields(r, input.currency));
  for (const r of input.byContext) lines.push(csvRowFields(r, input.currency));
  for (const r of input.byModel) lines.push(csvRowFields(r, input.currency));
  for (const r of input.byMembership) lines.push(csvRowFields(r, input.currency));

  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

function csvRowFields(r: UsageCsvRow, currency: string): string {
  return [
    r.scope,
    r.label,
    r.calls.toString(),
    r.inputTokens.toString(),
    r.outputTokens.toString(),
    r.cacheReadTokens.toString(),
    r.cacheCreationTokens.toString(),
    r.costMinor.toString(),
    currency,
  ]
    .map(csvField)
    .join(",");
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  if (!CSV_NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
