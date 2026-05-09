import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { activateTerms, amendTerms } from "@/lib/terms";

const activateSchema = z.object({
  tenantSlug: z.string(),
  action: z.literal("activate"),
});

const amendSchema = z.object({
  tenantSlug: z.string(),
  action: z.literal("amend"),
  body: z.string().min(1).max(200_000).optional(),
  documentRef: z.string().min(1).max(1_000).optional(),
  notes: z.string().max(4_000).nullable().optional(),
  signedByName: z.string().max(200).nullable().optional(),
  signedByRole: z.string().max(200).nullable().optional(),
  signedAt: z.string().nullable().optional(),
  countersignedByName: z.string().max(200).nullable().optional(),
  countersignedAt: z.string().nullable().optional(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
});

const schema = z.discriminatedUnion("action", [activateSchema, amendSchema]);

/**
 * PUT /api/terms/:id — activate a DRAFT or amend a DRAFT in place
 * (PRD §15.4). Activation supersedes any previous ACTIVE record of the
 * same kind. Amendments to ACTIVE / SUPERSEDED records are refused — they
 * require a new version via POST /api/terms.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = schema.safeParse(body);
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
    if (parsed.data.action === "activate") {
      const record = await activateTerms({
        tenantId: ctx.tenant.id,
        recordId: id,
        actorMembershipId: ctx.membership.id,
      });
      return NextResponse.json({ record });
    }
    const record = await amendTerms({
      tenantId: ctx.tenant.id,
      recordId: id,
      body: parsed.data.body,
      documentRef: parsed.data.documentRef,
      notes: parsed.data.notes ?? undefined,
      signedByName: parsed.data.signedByName ?? undefined,
      signedByRole: parsed.data.signedByRole ?? undefined,
      signedAt: parseDate(parsed.data.signedAt),
      countersignedByName: parsed.data.countersignedByName ?? undefined,
      countersignedAt: parseDate(parsed.data.countersignedAt),
      effectiveFrom: parseDate(parsed.data.effectiveFrom),
      effectiveTo: parseDate(parsed.data.effectiveTo),
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ record });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
