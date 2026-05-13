/**
 * Post-PRD hardening item 87 — bracket boundaries for the shared
 * `@/lib/format/duration` extraction.
 *
 * Five existing call sites (sentiment metrics + responses-export, drafts
 * misses-export, /admin/drafts page, sentiment LiveOutstanding) plus the
 * new /drafts `<LiveDeadline />` countdown now route through this
 * formatter. The tests pin every bracket boundary so a future tweak —
 * e.g. raising the hours→days threshold from 48h to 72h — can't silently
 * drift one caller without the others.
 *
 * `formatTtaDuration` is asserted separately in `sentiment-metrics.test.ts`
 * (item 78); item 87 keeps that suite passing because the export now
 * re-aliases `formatDurationOrDash` under the historical name.
 */
import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatDurationOrDash,
} from "@/lib/format/duration";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it("renders sub-minute as <1m", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(1)).toBe("<1m");
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(59_999)).toBe("<1m");
  });

  it("renders exactly one minute as 1m", () => {
    expect(formatDuration(MINUTE)).toBe("1m");
  });

  it("renders minutes under 60 as Nm", () => {
    expect(formatDuration(45 * MINUTE)).toBe("45m");
    expect(formatDuration(59 * MINUTE)).toBe("59m");
  });

  it("renders hours under 48 as Nh", () => {
    expect(formatDuration(HOUR)).toBe("1h");
    expect(formatDuration(12 * HOUR)).toBe("12h");
    expect(formatDuration(47 * HOUR)).toBe("47h");
  });

  it("renders 48h+ as Nd", () => {
    expect(formatDuration(48 * HOUR)).toBe("2d");
    expect(formatDuration(5 * DAY)).toBe("5d");
    expect(formatDuration(30 * DAY)).toBe("30d");
  });

  it("clamps negatives + non-finite to <1m", () => {
    // Caller could pass `sentMarkedAt - deadline` for a draft sent just
    // under the wire and get a negative ms due to clock skew. Better to
    // collapse to "<1m" than render "-5m".
    expect(formatDuration(-1)).toBe("<1m");
    expect(formatDuration(-100_000)).toBe("<1m");
    expect(formatDuration(Number.NaN)).toBe("<1m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("<1m");
  });
});

describe("formatDurationOrDash", () => {
  it("renders null as em-dash", () => {
    expect(formatDurationOrDash(null)).toBe("—");
  });

  it("delegates to formatDuration for numbers", () => {
    expect(formatDurationOrDash(0)).toBe("<1m");
    expect(formatDurationOrDash(45 * MINUTE)).toBe("45m");
    expect(formatDurationOrDash(2 * DAY)).toBe("2d");
  });
});
