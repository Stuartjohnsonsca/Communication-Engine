import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { concludeSandbox } from "@/lib/sandbox";

const inputSchema = z
  .object({
    tenantSlug: z.string(),
    sandboxTenantId: z.string().min(1),
    outcome: z.enum(["PROMOTED", "ITERATING", "DECLINED"]),
    byName: z.string().min(1).max(200),
    notes: z.string().max(4_000).nullable().optional(),
    promotedFcgId: z.string().nullable().optional(),
  })
  .refine((v) => (v.outcome === "PROMOTED" ? !!v.promotedFcgId : true), {
    message: "PROMOTED requires promotedFcgId",
  });

/**
 * POST /api/sandbox/conclude — record the sandbox outcome (PRD §14.2).
 * Three outcomes: PROMOTED (lifts the chosen FCG to a §6 proposal on the
 * parent), ITERATING (operator will open a new window), DECLINED (the
 * sandbox tenant is marked TERMINATED).
 *
 * Audit events for the conclusion + promotion proposal are written against
 * the parent tenant's chain.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "sandbox:manage");

  try {
    const result = await concludeSandbox({
      sandboxTenantId: parsed.data.sandboxTenantId,
      parentTenantId: ctx.tenant.id,
      outcome: parsed.data.outcome,
      byName: parsed.data.byName,
      notes: parsed.data.notes ?? null,
      promotedFcgId: parsed.data.promotedFcgId ?? undefined,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({
      sandbox: result.sandbox,
      parentProposal: result.parentProposal ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
