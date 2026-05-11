/**
 * Next.js `instrumentation.ts` `onRequestError` dispatch logic.
 *
 * Coverage:
 *   - pathToTenantSlug: tenant paths return the slug; api/auth/login/
 *     status/_next/.well-known short-circuit to null; malformed slugs
 *     (uppercase only OK, special chars, oversized) return null.
 *   - buildReportContext: builds route + tenantSlug + tags + extra
 *     correctly for tenant-rendered pages, /api/v1 route handlers,
 *     middleware, and unknown route types.
 *   - handleRequestError: routes the error through reportError;
 *     a thrown reportContext-builder cannot crash the hook
 *     (belt-and-braces invariant).
 *   - tag shape: includes routeType, method (when present), renderSource,
 *     routerKind (when present); never includes undefined values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pathToTenantSlug,
  buildReportContext,
  handleRequestError,
} from "@/lib/observability/instrumentation-handler";
import { setLogLevel, getLogLevel } from "@/lib/observability";

type Captured = { stream: "stdout" | "stderr"; line: string };

function captureStreams() {
  const captured: Captured[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    captured.push({ stream: "stdout", line: String(chunk) });
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    captured.push({ stream: "stderr", line: String(chunk) });
    return true;
  });
  return {
    captured,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

function parseRecords(captured: Captured[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const c of captured) {
    const trimmed = c.line.trimEnd();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // ignore non-JSON
    }
  }
  return out;
}

describe("pathToTenantSlug", () => {
  it("extracts a typical tenant slug from a tenant-scoped path", () => {
    expect(pathToTenantSlug("/acme-firm/dashboard")).toBe("acme-firm");
    expect(pathToTenantSlug("/acumon/admin/security")).toBe("acumon");
    expect(pathToTenantSlug("/abc/")).toBe("abc");
  });

  it("strips query strings before parsing", () => {
    expect(pathToTenantSlug("/acme-firm/dashboard?foo=bar")).toBe("acme-firm");
  });

  it("returns null for API / auth / status / _next / .well-known paths", () => {
    expect(pathToTenantSlug("/api/v1/webhooks")).toBeNull();
    expect(pathToTenantSlug("/api/cron/lifecycle-sweep")).toBeNull();
    expect(pathToTenantSlug("/login")).toBeNull();
    expect(pathToTenantSlug("/login/verify")).toBeNull();
    expect(pathToTenantSlug("/auth/2fa")).toBeNull();
    expect(pathToTenantSlug("/status")).toBeNull();
    expect(pathToTenantSlug("/_next/static/chunks/foo.js")).toBeNull();
    expect(pathToTenantSlug("/.well-known/security.txt")).toBeNull();
  });

  it("returns null for empty / null / unparseable paths", () => {
    expect(pathToTenantSlug(null)).toBeNull();
    expect(pathToTenantSlug(undefined)).toBeNull();
    expect(pathToTenantSlug("")).toBeNull();
    expect(pathToTenantSlug("/")).toBeNull();
  });

  it("returns null for malformed first segments", () => {
    expect(pathToTenantSlug("/has spaces/x")).toBeNull();
    expect(pathToTenantSlug("/-leading-hyphen/x")).toBeNull();
    expect(pathToTenantSlug("/trailing-hyphen-/x")).toBeNull();
    expect(pathToTenantSlug("/has@symbol/x")).toBeNull();
    const huge = "a".repeat(64);
    expect(pathToTenantSlug(`/${huge}/x`)).toBeNull();
  });
});

describe("buildReportContext", () => {
  it("populates route, tenantSlug, tags, and extra for a tenant-rendered page", () => {
    const out = buildReportContext(
      { path: "/acme-firm/dashboard", method: "GET" },
      {
        routePath: "/[tenantSlug]/dashboard",
        routeType: "render",
        renderSource: "react-server-components",
        routerKind: "App Router",
      },
    );
    expect(out.route).toBe("/[tenantSlug]/dashboard");
    expect(out.tenantSlug).toBe("acme-firm");
    expect(out.tags.routeType).toBe("render");
    expect(out.tags.renderSource).toBe("react-server-components");
    expect(out.tags.routerKind).toBe("App Router");
    expect(out.tags.method).toBe("GET");
    expect(out.extra.path).toBe("/acme-firm/dashboard");
  });

  it("omits tenantSlug for /api/* paths", () => {
    const out = buildReportContext(
      { path: "/api/v1/webhooks/replay", method: "POST" },
      { routePath: "/api/v1/webhooks/replay", routeType: "route" },
    );
    expect(out.tenantSlug).toBeUndefined();
    expect(out.tags.routeType).toBe("route");
    expect(out.tags.method).toBe("POST");
  });

  it("falls back to the request path when routePath is missing", () => {
    const out = buildReportContext(
      { path: "/api/foo", method: "GET" },
      { routeType: "route" },
    );
    expect(out.route).toBe("/api/foo");
  });

  it("uses '(unknown)' for route when both routePath and path are missing", () => {
    const out = buildReportContext({}, { routeType: "action" });
    expect(out.route).toBe("(unknown)");
  });

  it("does not emit undefined tag values", () => {
    const out = buildReportContext({ path: "/x/y" }, { routeType: "render" });
    for (const v of Object.values(out.tags)) {
      expect(typeof v).toBe("string");
    }
  });
});

describe("handleRequestError", () => {
  let levelBefore: ReturnType<typeof getLogLevel>;
  let nodeEnvBefore: string | undefined;
  let cap: ReturnType<typeof captureStreams>;

  beforeEach(() => {
    levelBefore = getLogLevel();
    nodeEnvBefore = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    setLogLevel("debug");
    cap = captureStreams();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(levelBefore);
    if (nodeEnvBefore === undefined) vi.unstubAllEnvs();
    else {
      vi.stubEnv("NODE_ENV", nodeEnvBefore);
      vi.unstubAllEnvs();
    }
  });

  it("routes a server-action error through reportError with action-specific context", () => {
    const err = new Error("server action boom");
    handleRequestError(
      err,
      { path: "/acme-firm/admin/security", method: "POST" },
      { routePath: "/[tenantSlug]/admin/security", routeType: "action" },
    );
    const rec = parseRecords(cap.captured).find(
      (r) => typeof r.msg === "string" && (r.msg as string).includes("server action threw"),
    );
    expect(rec).toBeDefined();
    expect(rec!.level).toBe("error");
    expect(rec!.route).toBe("/[tenantSlug]/admin/security");
    expect(rec!.tenantSlug).toBe("acme-firm");
    const tags = rec!.tags as Record<string, unknown>;
    expect(tags.routeType).toBe("action");
    expect(tags.method).toBe("POST");
  });

  it("routes a route-handler error with route-specific context", () => {
    handleRequestError(
      new Error("v1 endpoint boom"),
      { path: "/api/v1/webhooks/replay", method: "POST" },
      { routePath: "/api/v1/webhooks/replay", routeType: "route" },
    );
    const rec = parseRecords(cap.captured).find(
      (r) => typeof r.msg === "string" && (r.msg as string).includes("route handler threw"),
    );
    expect(rec).toBeDefined();
    expect(rec!.tenantSlug).toBeUndefined();
  });

  it("routes middleware errors with the right context message", () => {
    handleRequestError(
      new Error("mw boom"),
      { path: "/anything", method: "GET" },
      { routeType: "middleware" },
    );
    const rec = parseRecords(cap.captured).find(
      (r) => typeof r.msg === "string" && (r.msg as string).includes("middleware threw"),
    );
    expect(rec).toBeDefined();
  });

  it("falls back to a generic message for unknown routeType", () => {
    handleRequestError(
      new Error("mystery"),
      { path: "/x" },
      { routeType: "something-new" },
    );
    const rec = parseRecords(cap.captured).find(
      (r) => typeof r.msg === "string" && (r.msg as string).includes("unhandled request error"),
    );
    expect(rec).toBeDefined();
  });

  it("never throws even when the input is malformed", () => {
    expect(() =>
      handleRequestError(
        new Error("x"),
        // @ts-expect-error — deliberately malformed for the safety test
        undefined,
        undefined as unknown as Parameters<typeof handleRequestError>[2],
      ),
    ).not.toThrow();
  });

  it("accepts a non-Error throw value", () => {
    handleRequestError(
      "just a string, not an Error",
      { path: "/api/test" },
      { routeType: "route" },
    );
    const rec = parseRecords(cap.captured).find(
      (r) => typeof r.msg === "string" && (r.msg as string).includes("route handler threw"),
    );
    expect(rec).toBeDefined();
  });
});
