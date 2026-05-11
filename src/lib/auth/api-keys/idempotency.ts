/**
 * Stripe-style idempotency keys for `/api/v1/*` write endpoints
 * (post-PRD hardening).
 *
 * Third-party integrators authenticated via an `ApiKey` (item 16) need a
 * safe retry path: a request can fail at the network edge after the
 * server has already executed it, and a naive retry would double-fire
 * the side-effect (e.g. enqueue the same `WebhookDelivery` twice). This
 * module gives them the standard Stripe header — clients pass
 * `Idempotency-Key: <opaque>` on the original request, retry with the
 * SAME header, and the server returns the original response without
 * re-executing.
 *
 * Lifecycle (three phases):
 *   1. RESERVE — insert a row with `completedAt = null`,
 *      `statusCode = null`. Uses the UNIQUE constraint on
 *      `(apiKeyId, key, methodPath)` to win the race against a
 *      concurrent retry.
 *   2. EXECUTE — run the handler. If it throws, drop the reservation
 *      so a subsequent retry can succeed.
 *   3. COMPLETE — UPDATE the row with status + body + completedAt.
 *
 * Replay semantics:
 *   - Same key, same body, completed row within TTL: return cached
 *     response. Handler NEVER runs.
 *   - Same key, DIFFERENT body, completed row: 422 conflict
 *     (`request body differs from original`). Stripe's canonical
 *     error for this.
 *   - Same key, reservation still in-flight: 409 conflict
 *     (`request still in progress`). Client should retry shortly.
 *   - Same key, expired row: row is purged + a fresh execution
 *     happens. Idempotency window has elapsed.
 *
 * TTL: 24 hours. Rows are garbage-collected by the lifecycle-sweep cron
 * (`purgeExpiredIdempotencyKeys`).
 *
 * Scope: keys are isolated per `(apiKeyId, methodPath)`. Same key value
 * against different endpoints, or from a different `ApiKey`, gets fresh
 * execution. Tenant isolation is enforced by RLS via `tenantId` on the
 * row — even if two tenants somehow used the same `apiKeyId`+`key`+`path`
 * triple (impossible in practice because `apiKeyId` is tenant-bound),
 * cross-tenant reads would be blocked at the DB.
 *
 * Response-body cap: 64KB. Larger responses are still returned to the
 * client on the first call, but the cache is skipped — a subsequent
 * retry will re-execute. Documented to integrators; in practice every
 * `/api/v1/*` response today is well under this cap.
 */
import { createHash } from "node:crypto";
import { superDb, superDbWith } from "@/lib/db";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MIN_KEY_LEN = 1;
export const IDEMPOTENCY_MAX_KEY_LEN = 200;
export const IDEMPOTENCY_RESPONSE_BODY_CAP_BYTES = 64 * 1024;

export type IdempotencyErrorCode =
  | "key-too-short"
  | "key-too-long"
  | "key-invalid-chars"
  | "body-conflict"
  | "in-progress";

export class IdempotencyError extends Error {
  code: IdempotencyErrorCode;
  /** HTTP status the caller should surface. */
  statusCode: number;
  constructor(code: IdempotencyErrorCode, message: string) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
    this.statusCode =
      code === "body-conflict"
        ? 422
        : code === "in-progress"
        ? 409
        : 400;
  }
}

export function hashRequestBody(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/**
 * Header value sanitiser. Refuses empty, oversized, and non-printable
 * keys (Stripe's spec: 1..200 ASCII printable chars).
 */
export function validateKey(key: string): void {
  if (key.length < IDEMPOTENCY_MIN_KEY_LEN) {
    throw new IdempotencyError("key-too-short", "idempotency key must not be empty");
  }
  if (key.length > IDEMPOTENCY_MAX_KEY_LEN) {
    throw new IdempotencyError(
      "key-too-long",
      `idempotency key must be ${IDEMPOTENCY_MAX_KEY_LEN} characters or fewer`,
    );
  }
  // ASCII printable only (0x20..0x7E) — refuse control chars / non-ASCII so
  // the key can be safely logged + used as an index lookup. Stripe accepts
  // any character but we tighten here to avoid surprises.
  if (!/^[\x20-\x7E]+$/.test(key)) {
    throw new IdempotencyError(
      "key-invalid-chars",
      "idempotency key contains non-printable or non-ASCII characters",
    );
  }
}

export type WithIdempotencyInput = {
  tenantId: string;
  apiKeyId: string;
  key: string;
  methodPath: string;
  requestHash: string;
  /** Test injection. Defaults to `new Date()`. */
  now?: () => Date;
};

export type IdempotencyResult = {
  statusCode: number;
  responseBody: string;
  /** True when this call returned a cached response without running fn. */
  replay: boolean;
};

/**
 * The wrapper a route handler calls. Performs the three-phase dance
 * and returns the final response.
 *
 * `fn` MUST return a serialisable response. The wrapper does not assume
 * a `Response` object — it accepts the deconstructed status code and
 * body so callers don't have to clone a streaming Response (and so we
 * can apply the cache size cap before serialisation).
 */
export async function withIdempotency<T extends IdempotencyResult>(
  input: WithIdempotencyInput,
  fn: () => Promise<{ statusCode: number; responseBody: string }>,
): Promise<IdempotencyResult> {
  validateKey(input.key);
  const now = input.now ? input.now() : new Date();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);

  // Phase 1: try to win the reservation.
  let reservationId: string;
  try {
    const reserved = await superDb.apiIdempotencyKey.create({
      data: {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        key: input.key,
        methodPath: input.methodPath,
        requestHash: input.requestHash,
        statusCode: null,
        responseBody: null,
        completedAt: null,
        expiresAt,
      },
      select: { id: true },
    });
    reservationId = reserved.id;
  } catch (err) {
    // UNIQUE violation — another request owns this slot. Fetch + decide.
    if (!isUniqueViolation(err)) throw err;
    return await replayOrConflict(input, now);
  }

  // Phase 2: execute the handler. On throw, drop the reservation so a
  // subsequent retry isn't permanently locked out.
  let response: { statusCode: number; responseBody: string };
  try {
    response = await fn();
  } catch (err) {
    await superDb.apiIdempotencyKey
      .delete({ where: { id: reservationId } })
      .catch(() => {
        // Best-effort cleanup — the reservation will expire via TTL
        // anyway, so don't mask the original error.
      });
    throw err;
  }

  // Phase 3: promote. Skip caching if the body is oversized so a giant
  // response doesn't pin the row table.
  const bodyBytes = Buffer.byteLength(response.responseBody, "utf8");
  if (bodyBytes > IDEMPOTENCY_RESPONSE_BODY_CAP_BYTES) {
    await superDb.apiIdempotencyKey
      .delete({ where: { id: reservationId } })
      .catch(() => {});
    return { ...response, replay: false };
  }
  await superDb.apiIdempotencyKey.update({
    where: { id: reservationId },
    data: {
      statusCode: response.statusCode,
      responseBody: response.responseBody,
      completedAt: now,
    },
  });
  return { ...response, replay: false };
}

async function replayOrConflict(
  input: WithIdempotencyInput,
  now: Date,
): Promise<IdempotencyResult> {
  const existing = await superDb.apiIdempotencyKey.findUnique({
    where: {
      apiKeyId_key_methodPath: {
        apiKeyId: input.apiKeyId,
        key: input.key,
        methodPath: input.methodPath,
      },
    },
  });
  if (!existing) {
    // The other request's reservation was already deleted (handler
    // threw or response oversized). Tell the caller to retry — the
    // window is microseconds, so 409 is the honest answer.
    throw new IdempotencyError(
      "in-progress",
      "concurrent request just released the key — retry shortly",
    );
  }
  if (existing.expiresAt < now) {
    // Expired — purge and tell the caller to retry. The caller's
    // retry will land on a clean slot.
    await superDb.apiIdempotencyKey
      .delete({ where: { id: existing.id } })
      .catch(() => {});
    throw new IdempotencyError(
      "in-progress",
      "idempotency key expired between lookup and use — retry",
    );
  }
  if (existing.requestHash !== input.requestHash) {
    throw new IdempotencyError(
      "body-conflict",
      "idempotency key reused with a different request body",
    );
  }
  if (existing.completedAt == null || existing.statusCode == null || existing.responseBody == null) {
    throw new IdempotencyError(
      "in-progress",
      "request with this idempotency key is still in progress",
    );
  }
  return {
    statusCode: existing.statusCode,
    responseBody: existing.responseBody,
    replay: true,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  return e.code === "P2002";
}

/**
 * Garbage-collect expired idempotency rows. Called from the
 * lifecycle-sweep cron. Wrapped in `superDbWith` so a runaway sweep
 * can't pin a pool connection.
 */
export async function purgeExpiredIdempotencyKeys(
  now: Date = new Date(),
  opts: { statementTimeoutMs?: number } = {},
): Promise<{ deleted: number }> {
  return superDbWith({ statementTimeoutMs: opts.statementTimeoutMs }, async (tx) => {
    const result = await tx.apiIdempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return { deleted: result.count };
  });
}
