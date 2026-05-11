import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/auth/api-keys";
import { replayDelivery } from "@/lib/webhooks/dispatch";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";

/**
 * POST /api/v1/webhooks/replay
 *
 * Body: `{ "deliveryId": "<id>" }`
 *
 * Programmatic replay of a previously enqueued webhook delivery. The
 * receiver gets a fresh PENDING row with the same canonical payload
 * the original delivery would have carried. Useful when a receiver
 * lost connectivity and wants Acumon to re-fire a specific event
 * without manual UI clicking.
 *
 * Scope: `webhooks:replay` (which the catalogue maps to the
 * underlying RBAC `webhooks:configure` permission — replay is a
 * mutation of the delivery queue, not just a read).
 */
export const dynamic = "force-dynamic";

export const POST = withApiKey({ scope: "webhooks:replay" }, async (req: NextRequest, ctx) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof (body as { deliveryId?: unknown }).deliveryId !== "string") {
    return NextResponse.json({ error: "deliveryId is required" }, { status: 400 });
  }
  const { deliveryId } = body as { deliveryId: string };

  const result = await replayDelivery({ tenantId: ctx.membership.tenantId, deliveryId });
  if (!result.replayed) {
    return NextResponse.json({ error: "delivery not found in this tenant" }, { status: 404 });
  }

  try {
    await writeAuditEvent({
      tenantId: ctx.membership.tenantId,
      eventType: "WEBHOOK_REPLAYED",
      actorMembershipId: ctx.membership.id,
      subjectType: "WebhookDelivery",
      subjectId: result.newDeliveryId ?? deliveryId,
      payload: {
        replayOfDeliveryId: deliveryId,
        newDeliveryId: result.newDeliveryId,
        viaApiKey: ctx.apiKey.id,
        apiKeyPrefix: ctx.apiKey.prefix,
      },
    });
  } catch (err) {
    reportError(err, { route: "v1/webhooks/replay", tenantId: ctx.membership.tenantId });
  }

  return NextResponse.json({
    replayed: true,
    newDeliveryId: result.newDeliveryId,
  });
});
