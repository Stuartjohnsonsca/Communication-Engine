/**
 * RFC 4180 CSV rendering for audit-event exports (post-PRD hardening
 * item 49). Lives in its own module so the route handler and the
 * integration test can both import the formatter without spinning up
 * a NextAuth session.
 *
 * Columns mirror the raw `AuditEvent` row — same posture as the
 * NDJSON exporter, no actor join — so reviewers who import both
 * formats see identical data shapes.
 *
 * UTF-8 BOM prefix so Excel honours non-ASCII characters on open.
 * Embedded `,` `"` CR and LF in any field force quoting; embedded
 * double quotes are doubled per RFC 4180.
 */

export const AUDIT_CSV_HEADER = [
  "seq",
  "createdAt",
  "eventType",
  "actorMembershipId",
  "subjectType",
  "subjectId",
  "hash",
  "prevHash",
  "payload",
] as const;

/// UTF-8 byte-order mark. Prefixed once at the start of the file so
/// Excel renders non-ASCII characters correctly on open.
export const UTF8_BOM = "﻿";

export type AuditCsvRow = {
  seq: bigint | number;
  createdAt: Date;
  eventType: string;
  actorMembershipId: string | null;
  subjectType: string;
  subjectId: string;
  hash: string;
  prevHash: string;
  payload: unknown;
};

export function formatAuditAsCsv(rows: readonly AuditCsvRow[]): string {
  const lines: string[] = [AUDIT_CSV_HEADER.join(",")];
  for (const e of rows) {
    lines.push(
      [
        e.seq.toString(),
        e.createdAt.toISOString(),
        e.eventType,
        e.actorMembershipId ?? "",
        e.subjectType,
        e.subjectId,
        e.hash,
        e.prevHash,
        // Payload is JSON; serialise compactly then escape as one field.
        JSON.stringify(e.payload ?? {}),
      ]
        .map(csvField)
        .join(","),
    );
  }
  // RFC 4180 line ending is CRLF. Trailing CRLF is intentional so the
  // file ends on a record-terminator that every spreadsheet tool
  // recognises without adding a phantom empty row.
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  if (!CSV_NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
