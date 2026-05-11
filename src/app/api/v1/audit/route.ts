import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/auth/api-keys";
import { tenantDb } from "@/lib/db";

/**
 * GET /api/v1/audit
 *
 * Programmatic audit-chain read for SIEM / archival integrations.
 * Returns up to `limit` events (default 200, max 1000) starting at
 * `seq > cursor` (cursor is the largest `seq` returned by the previous
 * page; first call passes 0).
 *
 * Tenant is resolved from the authenticating ApiKey — there's no
 * `?tenantSlug=` parameter, so cross-tenant access is structurally
 * impossible at this surface. Tenant-scoped reads go through
 * `tenantDb(...)` so RLS is the defence-in-depth backstop.
 *
 * Response shape is the smallest stable contract — `id`, `seq`,
 * `eventType`, `subjectType`, `subjectId`, `actorMembershipId`,
 * `payload`, `createdAt`, `hash`, `prevHash`. The hash chain is
 * exposed so a receiver can independently verify integrity (PRD §6.2).
 *
 * Pagination: caller polls with `?after=<last seq seen>` until the
 * response returns fewer rows than `limit`.
 */
export const dynamic = "force-dynamic";

export const GET = withApiKey({ scope: "audit:read" }, async (req: NextRequest, ctx) => {
  const url = new URL(req.url);
  const afterRaw = url.searchParams.get("after");
  const limitRaw = url.searchParams.get("limit");

  let after: bigint;
  try {
    after = afterRaw ? BigInt(afterRaw) : 0n;
  } catch {
    return NextResponse.json({ error: "after must be a non-negative integer" }, { status: 400 });
  }
  if (after < 0n) {
    return NextResponse.json({ error: "after must be a non-negative integer" }, { status: 400 });
  }

  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return NextResponse.json({ error: "limit must be ≥ 1" }, { status: 400 });
  }
  const limit = Math.min(parsedLimit, 1000);

  const db = tenantDb(ctx.membership.tenantId);
  const rows = await db.auditEvent.findMany({
    where: { seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit,
    select: {
      id: true,
      seq: true,
      eventType: true,
      subjectType: true,
      subjectId: true,
      actorMembershipId: true,
      payload: true,
      createdAt: true,
      hash: true,
      prevHash: true,
    },
  });

  return NextResponse.json({
    tenantId: ctx.membership.tenantId,
    cursor: rows.length > 0 ? rows[rows.length - 1].seq.toString() : afterRaw ?? "0",
    hasMore: rows.length === limit,
    events: rows.map((row) => ({
      id: row.id,
      seq: row.seq.toString(),
      eventType: row.eventType,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      actorMembershipId: row.actorMembershipId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
      hash: row.hash,
      prevHash: row.prevHash,
    })),
  });
});
