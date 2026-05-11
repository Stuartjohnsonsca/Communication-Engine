/**
 * Next.js instrumentation hook (post-PRD hardening).
 *
 * `onRequestError` fires on every unhandled error thrown by a server
 * action, route handler, server component render, or middleware. We
 * route the error through `reportError` so it reaches the same
 * observability pipeline as explicit `reportError` calls in modules
 * (structured log + optional Sentry-store endpoint + optional generic
 * webhook). Without this hook, those errors land in Next's stderr
 * formatter only — invisible to downstream collectors.
 *
 * `register()` is the once-per-process bootstrap. Kept empty for now;
 * future tracing setup (OpenTelemetry, etc.) hooks here.
 */
import { handleRequestError } from "@/lib/observability/instrumentation-handler";

export async function register() {
  // Intentionally empty. Reserved for one-time process bootstrap.
}

export async function onRequestError(
  error: unknown,
  request: Parameters<typeof handleRequestError>[1],
  context: Parameters<typeof handleRequestError>[2],
) {
  handleRequestError(error, request, context);
}
