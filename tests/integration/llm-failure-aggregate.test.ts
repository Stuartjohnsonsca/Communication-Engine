/**
 * Post-PRD hardening item 60 — failed-call aggregation.
 *
 * Tests cover:
 *   - normalisation: same prefix, different suffixes (request IDs,
 *     timestamps) collapse to one group.
 *   - exemplarMessage preserves the original casing + full text of
 *     the first-seen row (not the normalised version).
 *   - byMessage is sorted count-desc, ties broken by lastSeenAt-desc.
 *   - recent is sorted newest-first regardless of input order.
 *   - empty input returns the zero-shape (no throw).
 *   - null errorMessage rows bucket under "(no message)" — operators
 *     see a single distinct row rather than per-id orphans.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateFailures,
  normaliseErrorMessage,
  NORMALISED_MESSAGE_LEN,
  type FailedCallRow,
} from "@/lib/ai/usage";

function row(opts: Partial<FailedCallRow> & { id: string; createdAt: Date }): FailedCallRow {
  return {
    id: opts.id,
    role: opts.role ?? "draft",
    context: opts.context ?? "auto-draft",
    model: opts.model ?? "claude-haiku-4-5-20251001",
    provider: opts.provider ?? "anthropic",
    membershipId: opts.membershipId ?? null,
    errorMessage: opts.errorMessage ?? null,
    createdAt: opts.createdAt,
  };
}

describe("normaliseErrorMessage", () => {
  it("collapses to the first N characters, lowercased", () => {
    const long = "Rate Limit Error: 429 Too Many Requests xyz-".padEnd(200, "x");
    const n = normaliseErrorMessage(long);
    expect(n.length).toBeLessThanOrEqual(NORMALISED_MESSAGE_LEN);
    expect(n).toBe(n.toLowerCase());
    expect(n.startsWith("rate limit error")).toBe(true);
  });

  it("returns (no message) for null/empty", () => {
    expect(normaliseErrorMessage(null)).toBe("(no message)");
    expect(normaliseErrorMessage("")).toBe("(no message)");
    expect(normaliseErrorMessage("   ")).toBe("(no message)");
  });
});

describe("aggregateFailures — grouping", () => {
  it("collapses rows whose prefix matches under NORMALISED_MESSAGE_LEN", () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = [
      row({
        id: "r1",
        errorMessage: "rate_limit_error: 429 retry after 5s [request-abc]",
        createdAt: base,
      }),
      row({
        id: "r2",
        errorMessage: "rate_limit_error: 429 retry after 5s [request-def]",
        createdAt: new Date(base.getTime() + 60_000),
      }),
      row({
        id: "r3",
        errorMessage: "connection refused: tcp localhost:443",
        createdAt: new Date(base.getTime() + 120_000),
      }),
    ];
    const agg = aggregateFailures(rows);
    expect(agg.totalFailures).toBe(3);
    expect(agg.byMessage.length).toBe(2);
    const top = agg.byMessage[0]!;
    expect(top.count).toBe(2);
    // exemplarMessage preserves the original casing + suffix
    expect(top.exemplarMessage).toContain("rate_limit_error");
    expect(top.exemplarMessage).toContain("request-abc");
  });

  it("byMessage is sorted by count desc, ties by lastSeenAt desc", async () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = [
      row({ id: "a1", errorMessage: "error A", createdAt: base }),
      row({ id: "b1", errorMessage: "error B", createdAt: new Date(base.getTime() + 60_000) }),
      row({ id: "b2", errorMessage: "error B", createdAt: new Date(base.getTime() + 120_000) }),
      row({ id: "b3", errorMessage: "error B", createdAt: new Date(base.getTime() + 180_000) }),
      // Tied count with A1 → should sort by lastSeenAt; "error C" is newer
      row({ id: "c1", errorMessage: "error C", createdAt: new Date(base.getTime() + 240_000) }),
    ];
    const agg = aggregateFailures(rows);
    expect(agg.byMessage[0]!.count).toBe(3); // error B
    expect(agg.byMessage[1]!.normalisedMessage).toBe("error c"); // tied with A but newer
    expect(agg.byMessage[2]!.normalisedMessage).toBe("error a");
  });

  it("collects every context seen for a given message bucket", async () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = [
      row({ id: "r1", errorMessage: "boom", context: "auto-draft", createdAt: base }),
      row({
        id: "r2",
        errorMessage: "boom",
        context: "sentiment-classify",
        createdAt: new Date(base.getTime() + 60_000),
      }),
      row({
        id: "r3",
        errorMessage: "boom",
        context: "auto-draft",
        createdAt: new Date(base.getTime() + 120_000),
      }),
    ];
    const agg = aggregateFailures(rows);
    expect(agg.byMessage.length).toBe(1);
    expect(Array.from(agg.byMessage[0]!.contexts).sort()).toEqual(
      ["auto-draft", "sentiment-classify"].sort(),
    );
  });
});

describe("aggregateFailures — recent ordering", () => {
  it("returns newest first regardless of input order", async () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = [
      row({ id: "r1", createdAt: new Date(base.getTime() + 60_000) }),
      row({ id: "r2", createdAt: new Date(base.getTime() + 180_000) }),
      row({ id: "r3", createdAt: new Date(base.getTime() + 120_000) }),
    ];
    const agg = aggregateFailures(rows);
    expect(agg.recent.map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
  });

  it("respects recentLimit", async () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = Array.from({ length: 30 }, (_, i) =>
      row({ id: `r${i}`, createdAt: new Date(base.getTime() + i * 1000) }),
    );
    const agg = aggregateFailures(rows, { recentLimit: 5 });
    expect(agg.recent.length).toBe(5);
    // Newest first
    expect(agg.recent[0]!.id).toBe("r29");
  });
});

describe("aggregateFailures — edge cases", () => {
  it("returns zero-shape on empty input", async () => {
    const agg = aggregateFailures([]);
    expect(agg.totalFailures).toBe(0);
    expect(agg.byMessage).toEqual([]);
    expect(agg.recent).toEqual([]);
  });

  it("buckets null errorMessage rows under (no message)", async () => {
    const base = new Date("2026-05-12T10:00:00Z");
    const rows: FailedCallRow[] = [
      row({ id: "r1", errorMessage: null, createdAt: base }),
      row({
        id: "r2",
        errorMessage: null,
        createdAt: new Date(base.getTime() + 60_000),
      }),
    ];
    const agg = aggregateFailures(rows);
    expect(agg.byMessage.length).toBe(1);
    expect(agg.byMessage[0]!.normalisedMessage).toBe("(no message)");
    expect(agg.byMessage[0]!.count).toBe(2);
  });
});
