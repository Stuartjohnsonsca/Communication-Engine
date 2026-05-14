/**
 * Post-PRD hardening item 96 — shared median-TTA trend pill.
 *
 * Pure-function tests for the tone decision logic. The five previous
 * duplicates inlined this arithmetic; consolidating means a regression
 * here would silently move colour/arrow behaviour for every surface
 * at once, so the rules are pinned here rather than re-asserted at
 * each call site.
 *
 * Mirrors the test discipline of `bootstrapMedianCi95` in
 * `sentiment-metrics.test.ts` / `adherence-metrics.test.ts` (item 80
 * + 92): export the decision helper, test it directly. The React
 * component is a thin formatter around this helper; its rendered
 * output is exercised by the surface integration paths (firm-ack
 * monitor, /sentiment, /adherence/escalations, /account) that already
 * compute the metrics.
 *
 * The four behavioural invariants below are LOAD-BEARING. Any change
 * to the flat-band, colour mapping, or null-prior rule moves the
 * line for /sentiment + /account + /adherence/escalations at once.
 * Deliberate change requires updating these assertions.
 */
import { describe, it, expect } from "vitest";
import { computeMedianTtaTrendTone } from "@/components/MedianTtaTrendPill";

const MIN_MS = 60_000;

describe("computeMedianTtaTrendTone — null suppression", () => {
  it("returns null when current is null (no acks landed in current window)", () => {
    expect(
      computeMedianTtaTrendTone({ current: null, prior: 5 * MIN_MS }),
    ).toBeNull();
  });

  it("returns null when prior is null (no acks landed in prior window)", () => {
    expect(
      computeMedianTtaTrendTone({ current: 5 * MIN_MS, prior: null }),
    ).toBeNull();
  });

  it("returns null when both sides are null", () => {
    expect(computeMedianTtaTrendTone({ current: null, prior: null })).toBeNull();
  });
});

describe("computeMedianTtaTrendTone — inverted colour rule for latency", () => {
  // Faster (delta < 0) = ↓ green = good. Slower (delta > 0) = ↑ red = bad.
  // This inversion vs rate pills is the load-bearing UX rule the
  // consolidation has to preserve identically across all five surfaces.
  it("faster by more than flat band → ↓ emerald (lower latency = better)", () => {
    // prior = 60min, current = 50min → delta = -10min, flat band =
    // max(60s, 0.1 * 60min) = 6min. |delta| > flat band → fires.
    const tone = computeMedianTtaTrendTone({
      current: 50 * MIN_MS,
      prior: 60 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↓");
    expect(tone!.toneCls).toContain("emerald");
    expect(tone!.deltaMs).toBe(-10 * MIN_MS);
    expect(tone!.directionWord).toBe("−");
  });

  it("slower by more than flat band → ↑ red (higher latency = worse)", () => {
    const tone = computeMedianTtaTrendTone({
      current: 70 * MIN_MS,
      prior: 60 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↑");
    expect(tone!.toneCls).toContain("red");
    expect(tone!.deltaMs).toBe(10 * MIN_MS);
    expect(tone!.directionWord).toBe("+");
  });

  it("inside flat band → → neutral grey", () => {
    // prior = 60min, current = 62min → delta = +2min, flat band = 6min.
    // |delta| < flat band → neutral.
    const tone = computeMedianTtaTrendTone({
      current: 62 * MIN_MS,
      prior: 60 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("→");
    expect(tone!.toneCls).toContain("ink/20");
  });
});

describe("computeMedianTtaTrendTone — flat-band rule (max 60s, 10% of prior)", () => {
  // The combined absolute + relative floor is the load-bearing rule
  // preserved across all five surfaces. A fixed 1m absolute threshold
  // would over-flag wobble at high values; a pure relative threshold
  // would over-flag noise at low values. Both ends are tested.
  it("at low prior values the 60s absolute floor dominates", () => {
    // prior = 30s, 10% would be 3s — but the 60s floor wins.
    // current = 30s + 30s delta → still inside flat band.
    const tone = computeMedianTtaTrendTone({
      current: 60_000,
      prior: 30_000,
    });
    expect(tone).not.toBeNull();
    expect(tone!.flatBandMs).toBe(60_000);
    // |delta| = 30s, flat band = 60s → inside → neutral.
    expect(tone!.arrow).toBe("→");
  });

  it("at high prior values the 10% relative band dominates", () => {
    // prior = 4h = 240min. 10% = 24min. Absolute floor (60s) is far
    // below — relative wins.
    const tone = computeMedianTtaTrendTone({
      current: 4 * 60 * MIN_MS + 2 * MIN_MS, // +2min vs prior
      prior: 4 * 60 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.flatBandMs).toBe(24 * MIN_MS);
    // |delta| = 2min, flat band = 24min → inside → neutral.
    // This is the load-bearing case: at 4h median, a 2min jitter is
    // not a real direction change.
    expect(tone!.arrow).toBe("→");
  });

  it("absolute floor catches sub-minute noise at small prior values", () => {
    // prior = 50s, current = 50s + 30s. Without the absolute floor
    // (10% = 5s) this would trip; with the 60s floor it's neutral.
    // Tests that low-prior tenants aren't noise-tripped.
    const tone = computeMedianTtaTrendTone({
      current: 80_000,
      prior: 50_000,
    });
    expect(tone).not.toBeNull();
    expect(tone!.flatBandMs).toBe(60_000);
    expect(tone!.arrow).toBe("→"); // |delta| = 30s < 60s
  });

  it("crossing the flat band threshold flips to a tone (boundary check)", () => {
    // Pick numbers where prior * 0.1 is comfortably above the 60s
    // absolute floor: prior = 100min → flat band = 10min. Delta = 11min
    // should trip.
    const tone = computeMedianTtaTrendTone({
      current: 111 * MIN_MS,
      prior: 100 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.flatBandMs).toBe(10 * MIN_MS);
    expect(tone!.arrow).toBe("↑"); // +11min > 10min flat band
  });
});

describe("computeMedianTtaTrendTone — equal values render neutral, not red/green", () => {
  // A zero delta is operationally "we held the line." The pill renders
  // → grey with `±` direction word. This guards against a future
  // refactor that might accidentally treat equality as a direction.
  it("delta === 0 → → with directionWord '±'", () => {
    const tone = computeMedianTtaTrendTone({
      current: 60 * MIN_MS,
      prior: 60 * MIN_MS,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("→");
    expect(tone!.directionWord).toBe("±");
    expect(tone!.deltaMs).toBe(0);
  });
});
