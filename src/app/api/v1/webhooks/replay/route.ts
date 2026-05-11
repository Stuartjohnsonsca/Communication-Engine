import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  withApiKey,
  withIdempotency,
  hashRequestBody,
  validateIdempotencyKey,
  IdempotencyError,
  IDEMPOTENCY_HEADER,
} from "@/lib/auth/api-keys";
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
 *
 * Idempotency: optional `Idempotency-Key: <opaque>` header. When set,
 * a retry with the same key + same body returns the original response
 * without re-enqueueing. Same key with a different body is 422.
 * Concurrent same-key retries get 409. Keys are scoped per
 * `(apiKeyId, method, path)` and expire after 24h.
 */
export const dynamic = "force-dynamic";

const METHOD_PATH = "POST /api/v1/webhooks/replay";

export const POST = withApiKey({ scope: "webhooks:replay" }, async (req: NextRequest, ctx) => {
  const rawBody = await req.text();
  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    typeof (parsedBody as { deliveryId?: unknown }).deliveryId !== "string"
  ) {
    return NextResponse.json({ error: "deliveryId is required" }, { status: 400 });
  }
  const { deliveryId } = parsedBody as { deliveryId: string };

  const idempotencyKey = req.headers.get(IDEMPOTENCY_HEADER);

  const runHandler = async (): Promise<{ statusCode: number; responseBody: string }> => {
    const result = await replayDelivery({ tenantId: ctx.membership.tenantId, deliveryId });
    if (!result.replayed) {
      return {
        statusCode: 404,
        responseBody: JSON.stringify({ error: "delivery not found in this tenant" }),
      };
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
          idempotencyKey: idempotencyKey ? maskKey(idempotencyKey) : null,
        },
      });
    } catch (err) {
      reportError(err, { route: "v1/webhooks/replay", tenantId: ctx.membership.tenantId });
    }
    return {
      statusCode: 200,
      responseBody: JSON.stringify({
        replayed: true,
        newDeliveryId: result.newDeliveryId,
      }),
    };
  };

  if (!idempotencyKey) {
    const out = await runHandler();
    return new NextResponse(out.responseBody, {
      status: out.statusCode,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    validateIdempotencyKey(idempotencyKey);
  } catch (err) {
    if (err instanceof IdempotencyError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    throw err;
  }

  try {
    const out = await withIdempotency(
      {
        tenantId: ctx.membership.tenantId,
        apiKeyId: ctx.apiKey.id,
        key: idempotencyKey,
        methodPath: METHOD_PATH,
        requestHash: hashRequestBody(rawBody),
      },
      runHandler,
    );
    return new NextResponse(out.responseBody, {
      status: out.statusCode,
      headers: {
        "content-type": "application/json",
        "idempotency-replay": out.replay ? "true" : "false",
      },
    });
  } catch (err) {
    if (err instanceof IdempotencyError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    throw err;
  }
});

function maskKey(key: string): string {
  if (key.length <= 6) return key[0] + "***";
  return key.slice(0, 4) + "***" + key.slice(-2);
}
