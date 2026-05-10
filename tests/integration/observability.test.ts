/**
 * Logger + redaction + reportError unit tests.
 *
 * These don't touch Postgres but live alongside the integration suite so
 * `npm test` runs them in the same fork. Important properties:
 *   - sensitive keys (token/password/secret/etc.) never appear in log output;
 *   - `with()` builds a child logger that merges bound fields into every record;
 *   - level threshold suppresses lower-priority records;
 *   - `reportError` always emits a structured log even with no remote backend
 *     configured, and never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  log,
  loggerFor,
  setLogLevel,
  getLogLevel,
  generateRequestId,
  reportError,
  REQUEST_ID_HEADER,
  requestIdFromHeaders,
} from "../../src/lib/observability";

type Captured = { stream: "stdout" | "stderr"; line: string };

function captureStreams() {
  const captured: Captured[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      captured.push({ stream: "stdout", line: String(chunk) });
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
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

describe("observability/logger", () => {
  let levelBefore: ReturnType<typeof getLogLevel>;
  let nodeEnvBefore: string | undefined;
  let cap: ReturnType<typeof captureStreams>;

  beforeEach(() => {
    levelBefore = getLogLevel();
    nodeEnvBefore = process.env.NODE_ENV;
    // Force JSON output for deterministic parsing.
    vi.stubEnv("NODE_ENV", "production");
    setLogLevel("debug");
    cap = captureStreams();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(levelBefore);
    if (nodeEnvBefore === undefined) vi.unstubAllEnvs();
    else vi.stubEnv("NODE_ENV", nodeEnvBefore);
  });

  function records() {
    return cap.captured.map((c) => ({
      stream: c.stream,
      record: JSON.parse(c.line.trimEnd()) as Record<string, unknown>,
    }));
  }

  it("emits info to stdout and error to stderr with structured fields", () => {
    log.info("hello", { count: 3 });
    log.error("boom", new Error("nope"), { tenantId: "t1" });

    const recs = records();
    expect(recs).toHaveLength(2);

    expect(recs[0].stream).toBe("stdout");
    expect(recs[0].record.level).toBe("info");
    expect(recs[0].record.msg).toBe("hello");
    expect(recs[0].record.count).toBe(3);
    expect(recs[0].record.service).toBe("communication-engine");
    expect(typeof recs[0].record.ts).toBe("string");

    expect(recs[1].stream).toBe("stderr");
    expect(recs[1].record.level).toBe("error");
    expect(recs[1].record.msg).toBe("boom");
    expect(recs[1].record.tenantId).toBe("t1");
    const err = recs[1].record.err as { message: string; name: string; stack: string };
    expect(err.message).toBe("nope");
    expect(err.name).toBe("Error");
    expect(typeof err.stack).toBe("string");
  });

  it("redacts sensitive fields anywhere in the record (case-insensitive)", () => {
    log.info("processed", {
      user: "u1",
      Authorization: "Bearer xyz",
      tokens: { accessToken: "abc", refreshToken: "def" },
      payload: { password: "p", nested: { ApiKey: "secret-1" } },
    });

    const rec = records()[0].record as Record<string, unknown>;
    expect(rec.user).toBe("u1");
    expect(rec.Authorization).toBe("[redacted]");
    const tokens = rec.tokens as Record<string, unknown>;
    expect(tokens.accessToken).toBe("[redacted]");
    expect(tokens.refreshToken).toBe("[redacted]");
    const payload = rec.payload as Record<string, unknown>;
    expect(payload.password).toBe("[redacted]");
    expect((payload.nested as Record<string, unknown>).ApiKey).toBe("[redacted]");
  });

  it("with() merges bound fields into every record without mutating the parent", () => {
    const child = log.with({ requestId: "r1", route: "/x" });
    child.info("a");
    log.info("b");

    const recs = records();
    expect(recs[0].record.requestId).toBe("r1");
    expect(recs[0].record.route).toBe("/x");
    expect(recs[1].record.requestId).toBeUndefined();
  });

  it("loggerFor builds a child logger from a partial context", () => {
    const reqLog = loggerFor({ requestId: "abc", tenantSlug: "demo" });
    reqLog.warn("late", { phase: "checkout" });

    const rec = records()[0].record;
    expect(rec.requestId).toBe("abc");
    expect(rec.tenantSlug).toBe("demo");
    expect(rec.phase).toBe("checkout");
    expect(rec.level).toBe("warn");
  });

  it("respects level threshold: silent suppresses everything", () => {
    setLogLevel("silent");
    log.error("ignored", new Error("x"));
    log.info("ignored");
    log.debug("ignored");
    expect(cap.captured).toHaveLength(0);
  });

  it("respects level threshold: warn keeps warn/error, drops info/debug", () => {
    setLogLevel("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e", new Error("err"));
    const recs = records();
    expect(recs.map((r) => r.record.level)).toEqual(["warn", "error"]);
  });

  it("serialises bigint cleanly (no JSON.stringify throw)", () => {
    log.info("bignum", { seq: 42n });
    const rec = records()[0].record;
    expect(rec.seq).toBe("42");
  });

  it("error() accepts a plain object as its second argument", () => {
    log.error("scoring failed", { ingestedMessageId: "im_1", reason: "judge timeout" });
    const rec = records()[0].record;
    expect(rec.ingestedMessageId).toBe("im_1");
    expect(rec.reason).toBe("judge timeout");
  });
});

describe("observability/request-id", () => {
  it("generates a 32-char hex token without dashes", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("preserves an upstream request-id when present", () => {
    const h = new Headers({ [REQUEST_ID_HEADER]: "client-trace-1" });
    expect(requestIdFromHeaders(h)).toBe("client-trace-1");
  });

  it("mints a new id when the header is absent", () => {
    const h = new Headers({});
    expect(requestIdFromHeaders(h)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects pathologically long ids", () => {
    const long = "x".repeat(200);
    const h = new Headers({ [REQUEST_ID_HEADER]: long });
    expect(requestIdFromHeaders(h)).not.toBe(long);
  });
});

describe("observability/reportError", () => {
  let levelBefore: ReturnType<typeof getLogLevel>;
  let nodeEnvBefore: string | undefined;
  let dsnBefore: string | undefined;
  let webhookBefore: string | undefined;
  let cap: ReturnType<typeof captureStreams>;

  beforeEach(() => {
    levelBefore = getLogLevel();
    nodeEnvBefore = process.env.NODE_ENV;
    dsnBefore = process.env.SENTRY_DSN;
    webhookBefore = process.env.OBSERVABILITY_WEBHOOK_URL;
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SENTRY_DSN;
    delete process.env.OBSERVABILITY_WEBHOOK_URL;
    setLogLevel("debug");
    cap = captureStreams();
  });

  afterEach(() => {
    cap.restore();
    setLogLevel(levelBefore);
    if (nodeEnvBefore === undefined) vi.unstubAllEnvs();
    else vi.stubEnv("NODE_ENV", nodeEnvBefore);
    if (dsnBefore === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = dsnBefore;
    if (webhookBefore === undefined) delete process.env.OBSERVABILITY_WEBHOOK_URL;
    else process.env.OBSERVABILITY_WEBHOOK_URL = webhookBefore;
  });

  it("logs a structured error and never throws when no backend is configured", () => {
    expect(() =>
      reportError(new Error("nope"), {
        tenantId: "t1",
        route: "api/test",
      }),
    ).not.toThrow();

    const lines = cap.captured.map((c) => JSON.parse(c.line.trimEnd()) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("error");
    expect(lines[0].tenantId).toBe("t1");
    expect(lines[0].route).toBe("api/test");
  });

  it("logs even when the error argument is not an Error instance", () => {
    expect(() => reportError("just a string", { route: "x" })).not.toThrow();
    const rec = JSON.parse(cap.captured[0].line.trimEnd()) as Record<string, unknown>;
    expect(rec.level).toBe("error");
    expect(rec.route).toBe("x");
  });

  it("fires a webhook POST when OBSERVABILITY_WEBHOOK_URL is set", async () => {
    process.env.OBSERVABILITY_WEBHOOK_URL = "https://example.invalid/hook";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    reportError(new Error("hi"), { route: "r", tags: { kind: "test" } });

    // Dispatch is fire-and-forget — yield once so the microtask runs.
    await new Promise((r) => setImmediate(r));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.invalid/hook");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.message).toBe("hi");
    expect((body.tags as Record<string, unknown>).kind).toBe("test");
    expect((body.tags as Record<string, unknown>).route).toBe("r");

    fetchSpy.mockRestore();
  });
});
