/**
 * Post-PRD hardening item 98 — shared rate trend pill. Consolidates
 * five previously-duplicated implementations:
 *
 *   - `AdherenceTrendPill` on /admin/drafts (item 72, firm-wide FCG-
 *     window adherence headline)
 *   - `CompactAdherenceTrendPill` on /admin/drafts (item 75, compact
 *     per-Member variant in the top-drafters table)
 *   - `MyAdherenceTrendPill` on /account (item 73, per-Member self-view
 *     adherence pill)
 *   - `AckRateTrendPill` on /sentiment (item 79, sentiment ack-rate
 *     headline)
 *   - `AdherenceAckRateTrendPill` on /adherence/escalations (item 91,
 *     adherence-escalation ack-rate headline)
 *
 * Item 96 consolidated the LATENCY pill family but left this RATE
 * family at four sites (its commit message undercounted by missing
 * the item-75 compact variant — fifth site was already in the tree).
 * Item 97 (per-Member median-TTA pill on /adherence/escalations) then
 * deferred its own analog per-Member ack-rate pill specifically
 * because adding a 6th rate-pill site before consolidation would
 * re-violate the duplicate-at-two, extract-at-three rule (items 68 /
 * 70 / 73 / 75 / 88). Item 98 closes the gap so the deferred per-
 * Member ack-rate pill can use this shared component cleanly when it
 * lands.
 *
 * **Rate, not latency.** The pill colour rule is NON-inverted vs the
 * median-TTA pill: higher rate = better, so ↑ green / ↓ red / → grey.
 * The colour mapping mirrors the rest of the codebase's percentage-
 * point pills (the rate-pill family the four originals belong to).
 *
 * **Flat-band is `FLAT_THRESHOLD = 0.01` (1pp)** — preserved verbatim
 * from all four originals. Rate pills don't need a relative band like
 * the latency pill: a 1pp delta is a 1pp delta whether the rate is 5%
 * or 95% (the underlying observation is "we acked one more / one
 * fewer per 100"). The absolute floor is the only band we need.
 *
 * **Denominator-zero suppression**: the pill renders nothing when the
 * prior window had zero qualifying signals (`priorDenominator === 0`).
 * A 12-month-old tenant with one current-window signal shouldn't see
 * a "+100pp vs prior 30d" pill against an empty prior window. The
 * caller passes whichever denominator produced the prior rate (`prior
 * escalated` for sentiment + adherence/escalations, `prior sent-with-
 * deadline` for /admin/drafts + /account adherence). Naming the prop
 * abstractly here keeps the four call sites speaking the same shape
 * without renaming their lib-level counters.
 *
 * **Renders nothing when either side is null** — matches the null-
 * prior invariant from items 72/73/79/91. Typically nulls happen
 * because the denominator was zero on one side (no signals → no rate).
 *
 * **API**: `priorLabelSuffix` lets a surface add a clarifying suffix to
 * the prior-rate label in the tooltip (e.g. `"acked"` on /sentiment
 * where "% acked" disambiguates from "% extreme" — the metric heading
 * isn't always next to the pill). The other four surfaces' headings
 * already carry the metric context, so they omit it. `compact` toggles
 * the in-table variant — drops the "vs prior Nd" body suffix (the
 * column heading carries the metric context) and shrinks
 * padding+text-size to fit inline. The tooltip retains the full prior%
 * + signed delta in either variant. `className` is spread onto the
 * pill element so each call site keeps its own outer-layout class
 * (`mt-1` to sit under a value, none to sit next to a heading) — same
 * shape as item 96's `MedianTtaTrendPill`.
 */
export function RateTrendPill({
  current,
  prior,
  priorDenominator,
  windowDays,
  priorLabelSuffix,
  compact = false,
  className,
}: {
  /// Current-window rate, [0, 1]. Null = denominator was zero in the
  /// current window; the pill renders nothing.
  current: number | null;
  /// Prior-window rate, same shape as `current`. Null = no comparable
  /// prior rate; the pill renders nothing rather than faking a delta
  /// against missing data.
  prior: number | null;
  /// The count that produced the prior rate (denominator). Zero =
  /// pill renders nothing — a current rate against an empty prior
  /// window doesn't speak to direction. Whichever counter the caller
  /// used for the rate's denominator (e.g. `priorMetrics.escalated`
  /// for ack-rate pills, `priorMetrics.sentWithDeadline` for
  /// adherence-rate pills).
  priorDenominator: number;
  /// Window length in days for the body text + tooltip. Must match
  /// the window the parent surface rendered the headline rate in
  /// (7 / 30 / 90 conventionally).
  windowDays: number;
  /// Optional clarifying suffix on the prior-rate label in the
  /// tooltip (e.g. `"acked"` → "vs prior 30d: 87% acked (+2pp)"). The
  /// surface heading often carries enough metric context for this to
  /// be omitted; sentiment uses it because the same surface also
  /// reports "% extreme" right next to "% acked."
  priorLabelSuffix?: string;
  /// True in table cells where the column heading carries the metric
  /// context — drops "vs prior Nd" from body, smaller padding+text.
  /// Preserves item 75's compact-variant rendering verbatim.
  compact?: boolean;
  /// Spread onto the pill `<span>` so each call site keeps its own
  /// outer-layout class (`mt-1` / none / `ml-2`).
  className?: string;
}) {
  const tone = computeRateTrendTone({ current, prior, priorDenominator });
  if (!tone) return null;

  const priorPct = Math.round(prior! * 100);
  const suffix = priorLabelSuffix ? ` ${priorLabelSuffix}` : "";
  const title = `vs prior ${windowDays}d: ${priorPct}%${suffix} (${tone.deltaPp >= 0 ? "+" : ""}${tone.deltaPp}pp)`;

  const sizeCls = compact
    ? "gap-0.5 px-1.5 py-0 text-[10px]"
    : "gap-1 px-2 py-0.5 text-[11px]";
  const merged = [
    "inline-flex items-center rounded-full border font-medium",
    sizeCls,
    tone.toneCls,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={merged} title={title}>
      <span aria-hidden="true">{tone.arrow}</span>
      <span>
        {tone.deltaPp >= 0 ? "+" : ""}
        {tone.deltaPp}pp{compact ? "" : ` vs prior ${windowDays}d`}
      </span>
    </span>
  );
}

/**
 * Pure decision logic for the rate pill — separated out so tests can
 * pin the arithmetic + flat-band + colour-mapping rules without
 * rendering React. The component above is a thin wrapper that adds
 * formatting + JSX. Mirror of item 96's `computeMedianTtaTrendTone`.
 *
 * Returns null when:
 *   - either side of the comparison is missing (the "no fake delta
 *     against missing data" invariant — items 72/73/79/91), OR
 *   - the prior denominator was zero (no qualifying signals in prior
 *     → no comparable rate, same suppression rule preserved from all
 *     four originals).
 *
 * Otherwise returns the arrow, tone class, integer pp delta, and the
 * flat-band threshold used for the call.
 *
 * Exported so tests can assert: null on either-null + denominator==0;
 * "↑" + emerald when rate rose by more than 1pp; "↓" + red when rate
 * fell by more than 1pp; "→" + grey when inside the flat band.
 */
export function computeRateTrendTone(input: {
  current: number | null;
  prior: number | null;
  priorDenominator: number;
}): null | {
  arrow: "↑" | "↓" | "→";
  toneCls: string;
  deltaPp: number;
  flatBandPp: number;
} {
  if (input.current === null || input.prior === null) return null;
  if (input.priorDenominator === 0) return null;
  const FLAT_THRESHOLD = 0.01;
  const delta = input.current - input.prior;
  const deltaPp = Math.round(delta * 100);

  let arrow: "↑" | "↓" | "→" = "→";
  let toneCls = "border-ink/20 bg-ink/5 text-ink/70";
  if (delta > FLAT_THRESHOLD) {
    arrow = "↑";
    toneCls = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else if (delta < -FLAT_THRESHOLD) {
    arrow = "↓";
    toneCls = "border-red-300 bg-red-50 text-red-900";
  }
  return { arrow, toneCls, deltaPp, flatBandPp: 1 };
}
