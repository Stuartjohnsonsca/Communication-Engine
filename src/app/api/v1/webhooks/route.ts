import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/auth/api-keys";
import { tenantDb } from "@/lib/db";

/**
 * GET /api/v1/webhooks
 *
 * Programmatic read of this tenant's webhook subscriptions + a paged
 * tail of recent deliveries. Useful for an integrator to verify which
 * events its receiver is expected to receive and to reconcile its own
 * receipt log against ours.
 *
 * `Authorization: Bearer ack_<key>` with scope `webhooks:read`.
 *
 * Response intentionally omits `secretEncrypted`; the signing secret
 * is shown to the issuing Firm Administrator once at creation time
 * and never read back, including via this surface.
 */
export const dynamic = "force-dynamic";

export const GET = withApiKey({ scope: "webhooks:read" }, async (req: NextRequest, ctx) => {
  const url = new URL(req.url);
  const includeDisabled = url.searchParams.get("includeDisabled") === "true";
  const deliveryLimitRaw = url.searchParams.get("deliveryLimit");
  const deliveryLimit = Math.min(Math.max(Number.parseInt(deliveryLimitRaw ?? "20", 10) || 20, 1), 200);

  const db = tenantDb(ctx.membership.tenantId);
  const subs = await db.webhookSubscription.findMany({
    where: includeDisabled ? {} : { enabled: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, url: true, eventTypes: true, enabled: true,
      autoDisableThreshold: true, consecutiveFailures: true,
      lastDeliveredAt: true, lastFailureAt: true, lastStatusCode: true,
      createdAt: true, updatedAt: true,
    },
  });

  const recentDeliveries = await db.webhookDelivery.findMany({
    orderBy: { createdAt: "desc" },
    take: deliveryLimit,
    select: {
      id: true, subscriptionId: true, eventType: true, status: true,
      attempt: true, maxAttempts: true, lastStatusCode: true,
      scheduledFor: true, completedAt: true, createdAt: true,
    },
  });

  return NextResponse.json({
    tenantId: ctx.membership.tenantId,
    subscriptions: subs.map((s) => ({
      ...s,
      lastDeliveredAt: s.lastDeliveredAt?.toISOString() ?? null,
      lastFailureAt: s.lastFailureAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    recentDeliveries: recentDeliveries.map((d) => ({
      ...d,
      scheduledFor: d.scheduledFor.toISOString(),
      completedAt: d.completedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});
