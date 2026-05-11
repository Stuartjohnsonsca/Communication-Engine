import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { recordTerms } from "@/lib/terms";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({
  tenantSlug: z.string(),
  kind: z.enum(["MSA", "DPA", "AUP", "SLA"]),
  documentRef: z.string().min(1).max(1_000),
  body: z.string().min(1).max(200_000),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  signedByName: z.string().max(200).nullable().optional(),
  signedByRole: z.string().max(200).nullable().optional(),
  signedAt: z.string().nullable().optional(),
  countersignedByName: z.string().max(200).nullable().optional(),
  countersignedAt: z.string().nullable().optional(),
  notes: z.string().max(4_000).nullable().optional(),
  activate: z.boolean().default(false),
});

/**
 * POST /api/terms — record a new terms version (PRD §15.4). When `activate`
 * is true the new version becomes ACTIVE immediately and any previous
 * ACTIVE version of the same kind moves to SUPERSEDED. When false, the
 * record is staged DRAFT for later activation.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "terms:manage");

  function parseDate(v: string | null | undefined): Date | null | undefined {
    if (v == null) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  try {
    const record = await recordTerms({
      tenantId: ctx.tenant.id,
      kind: parsed.data.kind,
      documentRef: parsed.data.documentRef,
      body: parsed.data.body,
      effectiveFrom: parseDate(parsed.data.effectiveFrom),
      effectiveTo: parseDate(parsed.data.effectiveTo),
      signedByName: parsed.data.signedByName ?? null,
      signedByRole: parsed.data.signedByRole ?? null,
      signedAt: parseDate(parsed.data.signedAt),
      countersignedByName: parsed.data.countersignedByName ?? null,
      countersignedAt: parseDate(parsed.data.countersignedAt),
      notes: parsed.data.notes ?? null,
      activate: parsed.data.activate,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ record });
  } catch (err) {
    // Typed application errors (carrying `statusCode` in [400, 499])
    // surface their message; anything else (Prisma internals, etc.)
    // logs via reportError + returns generic 500.
    return safeApiError(err, { ctx: { route: "api/terms", tenantId: ctx.tenant.id } });
  }
}
