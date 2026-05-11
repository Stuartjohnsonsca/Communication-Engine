/**
 * Logic for the Next.js `instrumentation.ts` `onRequestError` hook
 * (post-PRD hardening).
 *
 * Item 4 wired `reportError` into the observability pipeline (structured
 * log + optional Sentry-store endpoint + optional generic webhook) but
 * only call-sites that explicitly called `reportError` benefitted.
 * Unhandled errors from server actions, server components, route
 * handlers, and middleware bypass that pipeline entirely — they land in
 * Next's stderr formatter and the operator never sees them in Sentry /
 * the observability webhook.
 *
 * Next 15's `instrumentation.ts` `onRequestError` hook fires on every
 * such unhandled error. Routing it through `reportError` closes the
 * loop with zero per-handler plumbing.
 *
 * This file holds the *pure* logic — `instrumentation.ts` at the repo
 * root is the wiring. Keeping the dispatch separate lets us test it
 * without the Next.js runtime.
 */
import { reportError } from "./report";
import type { LogFields } from "./logger";

export type InstrumentationRequest = {
  path?: string | null;
  method?: string | null;
  headers?: Record<string, string | string[] | undefined> | Headers | null;
};

export type InstrumentationContext = {
  /** Next 15 `routePath` — the route file path (e.g. /[tenantSlug]/dashboard). */
  routePath?: string | null;
  /** Next 15 `routeType` — "render" | "route" | "action" | "middleware". */
  routeType?: string | null;
  /** Next 15 `renderSource` — "react-server-components" etc. */
  renderSource?: string | null;
  /** Next 15 `routerKind` — usually "App Router". */
  routerKind?: string | null;
};

/**
 * Best-effort extractor for the tenant slug from a request path. Returns
 * null when the path is in the API/login/status/auth lane (no tenant)
 * or unparseable. We accept paths beginning with `/<slug>/...` where
 * `<slug>` is a typical tenant slug shape (letters, digits, hyphen).
 *
 * Slugs are kept in step with the Tenant.slug constraint — but we don't
 * import that here to keep this module test-free of the Prisma client.
 * The regex is intentionally permissive; misses just degrade to
 * `tenantSlug: null` in the report rather than misattributing.
 */
const TENANT_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/i;
const NON_TENANT_PREFIXES = [
  "api",
  "login",
  "status",
  "auth",
  "_next",
  "favicon",
  "robots",
  ".well-known",
];

export function pathToTenantSlug(path: string | null | undefined): string | null {
  if (!path) return null;
  const cleaned = path.split("?")[0]?.replace(/^\//, "") ?? "";
  if (!cleaned) return null;
  const firstSeg = cleaned.split("/")[0] ?? "";
  if (!firstSeg) return null;
  if (NON_TENANT_PREFIXES.includes(firstSeg)) return null;
  if (!TENANT_SLUG_RE.test(firstSeg)) return null;
  return firstSeg;
}

/**
 * Build the `ReportContext` we'll hand to `reportError`. Falls through
 * to `null`/`undefined` rather than guessing when a field can't be
 * derived — Sentry/webhook reports tolerate sparse context.
 */
export function buildReportContext(
  req: InstrumentationRequest,
  ctx: InstrumentationContext,
): {
  route: string;
  tenantSlug?: string;
  tags: Record<string, string>;
  extra: LogFields;
} {
  const path = req.path ?? "";
  const tenantSlug = pathToTenantSlug(path);
  const route = ctx.routePath ?? path ?? "(unknown)";
  const tags: Record<string, string> = {
    routeType: ctx.routeType ?? "unknown",
  };
  if (ctx.renderSource) tags.renderSource = ctx.renderSource;
  if (ctx.routerKind) tags.routerKind = ctx.routerKind;
  if (req.method) tags.method = req.method;
  const extra: LogFields = {
    path,
  };
  return {
    route,
    tenantSlug: tenantSlug ?? undefined,
    tags,
    extra,
  };
}

/**
 * The actual hook body. Called from `instrumentation.ts`'s
 * `onRequestError`. Pure dispatch — never throws (reportError already
 * catches its own faults; we wrap again belt-and-braces because a hook
 * that throws crashes the Next runtime).
 */
export function handleRequestError(
  err: unknown,
  req: InstrumentationRequest,
  ctx: InstrumentationContext,
): void {
  try {
    const reportCtx = buildReportContext(req, ctx);
    reportError(err, reportCtx, contextMessage(ctx));
  } catch {
    // Belt-and-braces: a faulty observability path must NEVER crash the
    // Next runtime when it's already in error-handling mode.
  }
}

function contextMessage(ctx: InstrumentationContext): string {
  if (ctx.routeType === "action") return "server action threw";
  if (ctx.routeType === "route") return "route handler threw";
  if (ctx.routeType === "render") return "render path threw";
  if (ctx.routeType === "middleware") return "middleware threw";
  return "unhandled request error";
}
