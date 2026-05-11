/**
 * Typed application errors for /api/* libs (post-PRD hardening).
 *
 * Item 39 routed every /api/* catch through `safeApiError(err, ctx)`,
 * which surfaces messages only for errors with a duck-typed
 * `statusCode` in [400, 499]. The trade-off: lib functions throwing
 * plain `new Error("validation message")` started returning generic
 * 500 instead of 400-with-message — useful UX lost.
 *
 * This module is the recovery path. Subclasses of `ApiClientError`
 * carry `statusCode` + optional `code`; `safeApiError` already
 * surfaces them at their declared status with their message. Migrate
 * lib throws one module at a time — same posture as item 33's
 * `superDbWith` rollout.
 *
 * Why this hierarchy and not the existing per-module classes
 * (`WebhookValidationError`, `IdempotencyError`, etc.)? Those work
 * fine for callers that need to introspect a specific code path. The
 * generic hierarchy here is for the wider tail of lib throws — terms,
 * sandbox, termination, xcl, meetings — where a `throw new
 * ValidationError("X")` is enough and a bespoke class would be
 * over-engineering. Per-module typed errors STILL work via the same
 * `safeApiError` duck-type check; this hierarchy is additive, not a
 * replacement.
 */

export class ApiClientError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 400 — request body / parameters failed validation. */
export class ValidationError extends ApiClientError {
  constructor(message: string, code?: string) {
    super(message, 400, code);
    this.name = "ValidationError";
  }
}

/** 403 — authenticated but not allowed (RBAC, tenant mismatch, suspended). */
export class ForbiddenError extends ApiClientError {
  constructor(message: string, code?: string) {
    super(message, 403, code);
    this.name = "ForbiddenError";
  }
}

/** 404 — referenced resource doesn't exist. */
export class NotFoundError extends ApiClientError {
  constructor(message: string, code?: string) {
    super(message, 404, code);
    this.name = "NotFoundError";
  }
}

/**
 * 409 — request is in conflict with current resource state (e.g.
 * "cannot reactivate a superseded version", "already concluded").
 * Distinct from 400 because retrying with the same body won't help.
 */
export class ConflictError extends ApiClientError {
  constructor(message: string, code?: string) {
    super(message, 409, code);
    this.name = "ConflictError";
  }
}
