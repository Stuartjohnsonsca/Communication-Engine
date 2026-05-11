/**
 * HTTP request timing observability (post-PRD hardening).
 *
 * Coverage:
 *   - getSlowRequestThresholdMs parses env, falls back on garbage,
 *     enforces the 50ms minimum floor.
 *   - sanitiseTimingLabel preserves short labels, caps long labels, has
 *     a sentinel for empty/whitespace.
 *   - labelForRequest builds `<METHOD> <pathname>` and handles bad URLs.
 *   - timeRequest returns the fn's value unchanged on the fast path
 *     and emits NOTHING when duration < threshold (silent floor).
 *   - timeRequest emits a structured warn log when duration >= threshold.
 *     The record carries kind, label, durationMs, thresholdMs, method,
 *     pathname, and optional extras; raw sensitive keys are redacted
 *     by the logger's existing redactor.
 *   - timeRequest emits a warn log when the fn throws (slow OR fast)
 *     and re-throws the original error unchanged.
 *   - A logger failure does NOT suppress the handler's response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  timeRequest,
  getSlowRequestThresholdMs,
  sanitiseTimingLabel,
  labelForRequest,
  setLogLevel,
  getLogLevel,
} from "@/lib/observability";

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

function parseRecords(captured: Captured[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of captured) {
    const trimmed = c.line.trimEnd();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // non-JSON line — ignore
    }
  }
  return out;
}

describe("timing/env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("default 1000ms when env unset", () => {
    delete process.env.HTTP_SLOW_REQUEST_MS;
    expect(getSlowRequestThresholdMs()).toBe(1000);
  });

  it("parses env override", () => {
    vi.stubEnv("HTTP_SLOW_REQUEST_MS", "2500");
    expect(getSlowRequestThresholdMs()).toBe(2500);
  });

  it("falls back on garbage env", () => {
    vi.stubEnv("HTTP_SLOW_REQUEST_MS", "garbage");
    expect(getSlowRequestThresholdMs()).toBe(1000);
    vi.stubEnv("HTTP_SLOW_REQUEST_MS", "-5");
    expect(getSlowRequestThresholdMs()).toBe(1000);
  });

  it("enforces the 50ms minimum floor", () => {
    vi.stubEnv("HTTP_SLOW_REQUEST_MS", "10");
    expect(getSlowRequestThresholdMs()).toBe(50);
  });
});

describe("timing/pure helpers", () => {
  it("sanitiseTimingLabel preserves short labels and caps long ones", () => {
    expect(sanitiseTimingLabel("POST /api/v1/webhooks/replay")).toBe("POST /api/v1/webhooks/replay");
    const long = "x".repeat(200);
    const out = sanitiseTimingLabel(long);
    expect(out.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("sanitiseTimingLabel uses a sentinel for empty/whitespace", () => {
    expect(sanitiseTimingLabel("")).toBe("(unlabelled)");
    expect(sanitiseTimingLabel("   ")).toBe("(unlabelled)");
  });

  it("labelForRequest builds METHOD pathname and handles bad URLs", () => {
    const ok = labelForRequest({ method: "POST", url: "https://example.test/api/v1/x?y=1" });
    expect(ok.label).toBe("POST /api/v1/x");
    expect(ok.method).toBe("POST");
    expect(ok.pathname).toBe("/api/v1/x");

    const bad = labelForRequest({ method: "GET", url: "not a url" });
    expect(bad.label).toBe("GET (unparseable)");
    expect(bad.pathname).toBe("(unparseable)");
  });
});

describe("timing/timeRequest", () => {
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

  it("returns the value and emits NOTHING when under threshold", async () => {
    const out = await timeRequest(
      { label: "GET /fast" },
      async () => 42,
      { thresholdMs: 5000 },
    );
    expect(out).toBe(42);
    const slow = parseRecords(cap.captured).filter((r) => r.kind === "http-slow-request");
    expect(slow).toHaveLength(0);
  });

  it("emits a structured warn record when duration >= threshold", async () => {
    const out = await timeRequest(
      { label: "POST /slow", method: "POST", pathname: "/slow" },
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        return "ok";
      },
      { thresholdMs: 30, statusCode: () => 200 },
    );
    expect(out).toBe("ok");

    const slow = parseRecords(cap.captured).filter((r) => r.kind === "http-slow-request");
    expect(slow).toHaveLength(1);
    const rec = slow[0];
    expect(rec.level).toBe("warn");
    expect(rec.label).toBe("POST /slow");
    expect(rec.method).toBe("POST");
    expect(rec.pathname).toBe("/slow");
    expect(typeof rec.durationMs).toBe("number");
    expect((rec.durationMs as number) >= 30).toBe(true);
    expect(rec.thresholdMs).toBe(30);
    expect(rec.statusCode).toBe(200);
    expect(rec.threw).toBeUndefined();
  });

  it("re-throws the original error AND emits a warn record (slow OR fast)", async () => {
    await expect(
      timeRequest(
        { label: "POST /throws" },
        async () => {
          throw new Error("inner boom");
        },
        { thresholdMs: 5000 }, // far above the actual duration
      ),
    ).rejects.toThrow(/inner boom/);

    const slow = parseRecords(cap.captured).filter((r) => r.kind === "http-slow-request");
    expect(slow).toHaveLength(1);
    expect(slow[0].threw).toMatch(/Error:inner boom/);
  });

  it("captures status code via the callback at the very end of the request", async () => {
    let final = 0;
    await timeRequest(
      { label: "POST /late-status" },
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        final = 503;
        return final;
      },
      { thresholdMs: 30, statusCode: () => final },
    );
    const rec = parseRecords(cap.captured).find((r) => r.kind === "http-slow-request");
    expect(rec).toBeDefined();
    expect(rec!.statusCode).toBe(503);
  });

  it("never suppresses the handler value if the statusCode callback throws", async () => {
    const out = await timeRequest(
      { label: "POST /status-throws" },
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        return "still-fine";
      },
      {
        thresholdMs: 30,
        statusCode: () => {
          throw new Error("statusCode threw");
        },
      },
    );
    expect(out).toBe("still-fine");
    // The slow log still emits with statusCode undefined.
    const rec = parseRecords(cap.captured).find((r) => r.kind === "http-slow-request");
    expect(rec).toBeDefined();
    expect(rec!.statusCode).toBeUndefined();
  });

  it("truncates oversized string extras to 200 chars + ellipsis", async () => {
    const big = "x".repeat(500);
    await timeRequest(
      { label: "POST /extras", extra: { big } },
      async () => {
        await new Promise((r) => setTimeout(r, 60));
      },
      { thresholdMs: 30 },
    );
    const rec = parseRecords(cap.captured).find((r) => r.kind === "http-slow-request");
    expect(rec).toBeDefined();
    expect(typeof rec!.big).toBe("string");
    expect((rec!.big as string).length).toBeLessThanOrEqual(201);
    expect((rec!.big as string).endsWith("…")).toBe(true);
  });
});
