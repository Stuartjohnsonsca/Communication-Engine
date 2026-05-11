/**
 * Sanitised error response helper for `/api/*` route handlers
 * (post-PRD hardening).
 *
 * The pre-existing pattern across many route handlers was:
 *
 *   } catch (err) {
 *     return NextResponse.json(
 *       { error: err instanceof Error ? err.message : "unknown" },
 *       { status: 400 },
 *     );
 *   }
 *
 * Two problems with that:
 *   1. It surfaces the message of EVERY caught error to the client,
 *      including ones thrown by Prisma ("connection terminated
 *      unexpectedly", "relation \"X\" does not exist") or other library
 *      internals — useful reconnaissance for an attacker.
 *   2. Genuine domain errors get the same status (400) as everything
 *      else, even when "user not found" → 404, "scope-denied" → 403,
 *      etc. would be more accurate.
 *
 * `safeApiError(err, ctx)` is the canonical replacement. It distinguishes
 * "legitimate client error with safe-to-surface message" from
 * "anything else" via a duck-typed `statusCode` property on the error:
 *
 *   - `err.statusCode` is an integer in [400, 499] → surface
 *     `{ error: err.message, code?: err.code }` at that status. These
 *     are typed application errors (e.g. `IdempotencyError`,
 *     `WebhookValidationError`, `SubProcessorChangeValidationError`)
 *     whose messages are designed for caller consumption.
 *   - Anything else → log via `reportError` + return
 *     `{ error: "internal error" }` at status 500. Operator gets the
 *     full detail in Sentry/webhook; client gets nothing exploitable.
 *
 * Migrating an endpoint to this helper is a one-line swap.
 */
import { NextResponse } from "next/server";
import { reportError, type ReportContext } from "./report";

/** Error shape this helper recognises as "safe to surface". */
export type TypedApiError = {
  message: string;
  statusCode: number;
  code?: string;
  name?: string;
};

function isTypedApiError(err: unknown): err is TypedApiError {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.message === "string" &&
    typeof e.statusCode === "number" &&
    Number.isInteger(e.statusCode) &&
    e.statusCode >= 400 &&
    e.statusCode <= 499
  );
}

export type SafeApiErrorOptions = {
  /** Routing/correlation context for `reportError`. */
  ctx?: ReportContext;
  /**
   * Generic message the client sees when the error is NOT typed.
   * Default: "internal error". Override sparingly — vague is the
   * point.
   */
  fallbackMessage?: string;
  /**
   * If provided, additional pre-known error codes that should be
   * surfaced verbatim regardless of statusCode (e.g. caller knows the
   * inner throws a `code: "in-progress"` ChainVerificationError). Use
   * sparingly — the default duck-typed `statusCode` check covers the
   * normal case.
   */
  surfaceCodes?: string[];
};

export function safeApiError(err: unknown, opts: SafeApiErrorOptions = {}): Response {
  if (isTypedApiError(err)) {
    const body: Record<string, unknown> = { error: err.message };
    if (typeof err.code === "string") body.code = err.code;
    return NextResponse.json(body, { status: err.statusCode });
  }

  // Surface-codes opt-in path (rarely needed).
  if (opts.surfaceCodes && opts.surfaceCodes.length > 0 && err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (typeof code === "string" && opts.surfaceCodes.includes(code) && typeof message === "string") {
      return NextResponse.json({ error: message, code }, { status: 400 });
    }
  }

  // Anything else: log + generic 500.
  reportError(err, opts.ctx ?? {});
  return NextResponse.json(
    { error: opts.fallbackMessage ?? "internal error" },
    { status: 500 },
  );
}
