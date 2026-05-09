import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

/**
 * Self-serve toggles for the current member's preferences. Per PRD §9.2
 * the FCT may only see per-User adherence data when `perfDashOptIn = true`,
 * and per §9.3 sentiment-monitoring on outgoing comms requires
 * `sentimentOutOptIn`. Members own these decisions.
 */
const inputSchema = z.object({
  tenantSlug: z.string(),
  perfDashOptIn: z.boolean().optional(),
  sentimentOutOptIn: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const updated = await superDb.membership.update({
    where: { id: ctx.membership.id },
    data: {
      ...(parsed.data.perfDashOptIn !== undefined
        ? { perfDashOptIn: parsed.data.perfDashOptIn }
        : {}),
      ...(parsed.data.sentimentOutOptIn !== undefined
        ? { sentimentOutOptIn: parsed.data.sentimentOutOptIn }
        : {}),
    },
    select: {
      id: true,
      perfDashOptIn: true,
      sentimentOutOptIn: true,
    },
  });

  return NextResponse.json(updated);
}
