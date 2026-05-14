/**
 * Post-PRD hardening item 98 — shared rate trend pill.
 *
 * Pure-function tests for the tone decision logic. The four previous
 * duplicates inlined this arithmetic; consolidating means a regression
 * here would silently move colour/arrow behaviour for every surface
 * at once (/admin/drafts firm-wide adherence pill, /account self-view
 * adherence pill, /sentiment ack-rate pill, /adherence/escalations
 * ack-rate pill), so the rules are pinned here rather than re-asserted
 * at each call site.
 *
 * Mirrors the test discipline of `computeMedianTtaTrendTone` from
 * item 96 (`median-tta-trend-pill.test.ts`): export the decision
 * helper, test it directly. The React component is a thin formatter
 * around this helper; its rendered output is exercised by the surface
 * integration paths that already compute the metrics.
 *
 * The behavioural invariants below are LOAD-BEARING. Any change to
 * the flat-band, colour mapping, or null/zero-denominator suppression
 * rule moves the line for /admin/drafts + /account + /sentiment +
 * /adherence/escalations at once. Deliberate change requires updating
 * these assertions.
 */
import { describe, it, expect } from "vitest";
import { computeRateTrendTone } from "@/components/RateTrendPill";

describe("computeRateTrendTone — null + zero-denominator suppression", () => {
  it("returns null when current is null (no qualifying signals in current window)", () => {
    expect(
      computeRateTrendTone({
        current: null,
        prior: 0.8,
        priorDenominator: 10,
      }),
    ).toBeNull();
  });

  it("returns null when prior is null (no qualifying signals in prior window)", () => {
    expect(
      computeRateTrendTone({
        current: 0.8,
        prior: null,
        priorDenominator: 0,
      }),
    ).toBeNull();
  });

  it("returns null when both sides are null", () => {
    expect(
      computeRateTrendTone({
        current: null,
        prior: null,
        priorDenominator: 0,
      }),
    ).toBeNull();
  });

  it("returns null when priorDenominator is zero even if prior rate looks defined", () => {
    // The prior denominator being zero means the prior rate is not
    // comparable — even if the caller defensively passes `prior: 0`
    // instead of null, the pill must NOT render. This guards against
    // a future refactor where a lib starts returning `rate: 0` for
    // "no signals" instead of `null` — the suppression rule still
    // holds because the denominator-zero check is independent.
    expect(
      computeRateTrendTone({ current: 0.8, prior: 0, priorDenominator: 0 }),
    ).toBeNull();
  });
});

describe("computeRateTrendTone — non-inverted colour rule for rates", () => {
  // Higher rate = better, so ↑ green = good. Lower rate = worse, so
  // ↓ red = bad. This is the OPPOSITE of the median-TTA pill (item 96)
  // and the load-bearing UX rule the consolidation has to preserve
  // identically across all four surfaces.
  it("rate rose by more than 1pp → ↑ emerald (higher rate = better)", () => {
    // prior = 80%, current = 85% → delta = +5pp, flat band = 1pp.
    // |delta| > flat band → fires.
    const tone = computeRateTrendTone({
      current: 0.85,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↑");
    expect(tone!.toneCls).toContain("emerald");
    expect(tone!.deltaPp).toBe(5);
  });

  it("rate fell by more than 1pp → ↓ red (lower rate = worse)", () => {
    const tone = computeRateTrendTone({
      current: 0.75,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↓");
    expect(tone!.toneCls).toContain("red");
    expect(tone!.deltaPp).toBe(-5);
  });

  it("inside flat band → → neutral grey", () => {
    // prior = 80%, current = 80.5% → delta = +0.5pp, flat band = 1pp.
    // |delta| < flat band → neutral. Guards against wobble at typical
    // tenant-scale where 1pp month-over-month shouldn't read as
    // "improving" or "degrading."
    const tone = computeRateTrendTone({
      current: 0.805,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("→");
    expect(tone!.toneCls).toContain("ink/20");
  });
});

describe("computeRateTrendTone — flat-band rule (1pp absolute, no relative band)", () => {
  // Unlike the latency pill (item 96), the rate pill uses a pure
  // absolute flat band — a 1pp delta is a 1pp delta whether the rate
  // is 5% or 95%. The underlying observation count is what matters.
  // This is preserved verbatim from all four originals.
  it("exactly at the flat-band threshold renders neutral (strict > rule)", () => {
    // prior = 80%, current = 81% → delta = exactly +1pp. The strict
    // `> FLAT_THRESHOLD` rule means this stays neutral. Documented
    // here so a future refactor doesn't flip to `>=` and accidentally
    // start firing on jitter.
    const tone = computeRateTrendTone({
      current: 0.81,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("→");
    expect(tone!.flatBandPp).toBe(1);
  });

  it("just past the flat band crosses to a tone (boundary check)", () => {
    // Use 1.5pp to avoid floating-point hair-splitting around exactly
    // 1pp. Sufficient to assert the rule fires past the threshold.
    const tone = computeRateTrendTone({
      current: 0.815,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↑");
    expect(tone!.toneCls).toContain("emerald");
  });

  it("low absolute rates still produce 1pp band (no relative scaling)", () => {
    // prior = 5%, current = 7% → delta = +2pp, flat band = 1pp.
    // Fires green. A relative band would scale the threshold (10% of
    // 5% = 0.5pp) and over-flag noise; the load-bearing absolute
    // rule keeps the band uniform across the rate range.
    const tone = computeRateTrendTone({
      current: 0.07,
      prior: 0.05,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("↑");
    expect(tone!.deltaPp).toBe(2);
  });
});

describe("computeRateTrendTone — equal rates render neutral", () => {
  // A zero delta is operationally "we held the line." The pill
  // renders → grey. Guards against a future refactor accidentally
  // treating equality as a direction.
  it("delta === 0 → → with deltaPp 0", () => {
    const tone = computeRateTrendTone({
      current: 0.8,
      prior: 0.8,
      priorDenominator: 100,
    });
    expect(tone).not.toBeNull();
    expect(tone!.arrow).toBe("→");
    expect(tone!.deltaPp).toBe(0);
  });
});
