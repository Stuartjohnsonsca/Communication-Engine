import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { verifyAuditChain, writeAuditEvent } from "@/lib/audit";
import { formatAuditAsCsv } from "@/lib/audit-csv";

/**
 * Audit chain export.
 *
 * Two formats:
 *   - `?format=ndjson` (default; preserves the pre-item-49 contract for
 *     scrapers, audit-pipelines, and command-line tools): one JSON object
 *     per line, including every column on the raw `AuditEvent` row.
 *   - `?format=csv` (post-PRD hardening item 49): RFC 4180 CSV with a
 *     UTF-8 BOM prefix so Excel opens it correctly. Compliance reviewers
 *     who live in spreadsheets get a directly-importable file rather
 *     than having to convert NDJSON via a script.
 *
 * Both formats run the chain verification first and surface the result
 * in `X-Audit-Verified` so a reviewer importing the file can confirm
 * cryptographic integrity from the HTTP response alongside the contents.
 *
 * Every export writes an `AUDIT_EXPORTED` event whose payload includes
 * `format` so the chain itself records WHICH file shape was emitted.
 */

type ExportFormat = "ndjson" | "csv";

function parseFormat(raw: string | null): ExportFormat {
  if (raw === "csv") return "csv";
  return "ndjson";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "audit:export");

  const format = parseFormat(url.searchParams.get("format"));

  const verified = await verifyAuditChain(ctx.tenant.id);
  const events = await superDb.auditEvent.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { seq: "asc" },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "AUDIT_EXPORTED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Tenant",
    subjectId: ctx.tenant.id,
    payload: {
      count: events.length,
      format,
      verified: { ok: verified.ok, failedAt: verified.failedAt?.toString() ?? null },
    },
  });

  const verifiedHeader = verified.ok ? "ok" : `failed-at:${verified.failedAt}`;
  const filenameStem = `audit-${slug}-${Date.now()}`;

  if (format === "csv") {
    const body = formatAuditAsCsv(events);
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "x-audit-verified": verifiedHeader,
        "content-disposition": `attachment; filename="${filenameStem}.csv"`,
      },
    });
  }

  const ndjson =
    events
      .map((e) => JSON.stringify({ ...e, seq: e.seq.toString() }))
      .join("\n") + "\n";

  return new NextResponse(ndjson, {
    headers: {
      "content-type": "application/x-ndjson",
      "x-audit-verified": verifiedHeader,
      "content-disposition": `attachment; filename="${filenameStem}.ndjson"`,
    },
  });
}

