/**
 * `safeApiError` — sanitised error response helper for /api/* routes
 * (post-PRD hardening).
 *
 * Coverage:
 *   - Typed application errors (statusCode in [400, 499] + string
 *     message + optional code) surface their message verbatim with
 *     the typed status. `IdempotencyError`, `WebhookValidationError`,
 *     and similar all satisfy the duck-typed contract.
 *   - Out-of-range statusCode (300, 500, 999) → treated as untyped →
 *     generic 500 + logged.
 *   - Plain `Error` → generic 500 + logged. The original message NEVER
 *     appears in the response body — load-bearing leak invariant.
 *   - Non-Error throw (string, number, object) → generic 500 + logged.
 *   - `surfaceCodes` opt-in: an error whose `code` is in the explicit
 *     allow-list is surfaced at 400 regardless of statusCode.
 *   - Custom `fallbackMessage` is honoured.
 *   - Each non-typed path calls `reportError` exactly once with the
 *     supplied ctx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { safeApiError, setLogLevel, getLogLevel } from "@/lib/observability";

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

class TypedError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "TypedError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

describe("safeApiError", () => {
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

  it("surfaces a typed 400 application error with message + code at the typed status", async () => {
    const err = new TypedError(400, "name-required", "name is required");
    const res = safeApiError(err);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe("name is required");
    expect(body.code).toBe("name-required");
    // No log emission for legitimate client errors.
    const logs = parseRecords(cap.captured);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  it("surfaces a typed 409 in-progress conflict at the typed status", async () => {
    const err = new TypedError(409, "in-progress", "request still in progress");
    const res = safeApiError(err);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe("request still in progress");
    expect(body.code).toBe("in-progress");
  });

  it("surfaces a typed 422 body-conflict at the typed status", async () => {
    const err = new TypedError(422, "body-conflict", "request body differs from original");
    const res = safeApiError(err);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("request body differs from original");
  });

  it("falls through for statusCode outside [400, 499] (500, 300, 999) → generic 500", async () => {
    for (const sc of [300, 500, 999]) {
      const err = new TypedError(sc, "weird", "should never be surfaced");
      const res = safeApiError(err);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("internal error");
      expect(body.error).not.toContain("should never be surfaced");
    }
  });

  it("plain Error → generic 500; raw message NEVER appears in the response", async () => {
    const secretMsg = "Prisma: relation \"InternalSecretTable\" does not exist";
    const err = new Error(secretMsg);
    const res = safeApiError(err);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal error");
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(secretMsg);
    expect(serialised).not.toContain("InternalSecretTable");

    // But it WAS logged for the operator (load-bearing: incident-response
    // needs the original message in Sentry/webhook, just not in the
    // client response).
    const logs = parseRecords(cap.captured);
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog).toBeDefined();
  });

  it("non-Error throws (string, number, object) → generic 500 + logged", async () => {
    const inputs: unknown[] = ["string error", 42, { weird: true }, null, undefined];
    for (const i of inputs) {
      const res = safeApiError(i);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("internal error");
    }
    const logs = parseRecords(cap.captured);
    const errLogs = logs.filter((l) => l.level === "error");
    expect(errLogs.length).toBe(inputs.length);
  });

  it("honours custom fallbackMessage", async () => {
    const res = safeApiError(new Error("boom"), { fallbackMessage: "service unavailable" });
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("service unavailable");
  });

  it("surfaceCodes opt-in: known code surfaced at 400 regardless of missing statusCode", async () => {
    const err = Object.assign(new Error("idempotency replayed"), {
      code: "replay",
    });
    const res = safeApiError(err, { surfaceCodes: ["replay", "in-progress"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("idempotency replayed");
    expect(body.code).toBe("replay");
  });

  it("surfaceCodes opt-in: unknown code falls through to generic 500", async () => {
    const err = Object.assign(new Error("unrecognised"), { code: "mystery" });
    const res = safeApiError(err, { surfaceCodes: ["replay"] });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
  });

  it("propagates ctx to reportError (operator sees route in the log)", async () => {
    safeApiError(new Error("boom"), { ctx: { route: "api/test-ctx", tenantId: "t_42" } });
    const logs = parseRecords(cap.captured);
    const errLog = logs.find((l) => l.level === "error");
    expect(errLog).toBeDefined();
    expect(errLog!.route).toBe("api/test-ctx");
    expect(errLog!.tenantId).toBe("t_42");
  });
});
