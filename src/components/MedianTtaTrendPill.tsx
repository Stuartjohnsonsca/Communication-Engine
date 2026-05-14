import { formatDuration } from "@/lib/format/duration";

/**
 * Post-PRD hardening item 96 — shared median time-to-acknowledge
 * trend pill. Consolidates five previously-duplicated implementations:
 *
 *   - `MedianTtaTrendPill` on /sentiment (item 79, headline card)
 *   - `CompactMedianTtaTrendPill` on /sentiment (item 88, per-Member table)
 *   - `MyMedianTtaTrendPill` on /account (item 81, sentiment self-view)
 *   - `AdherenceMedianTtaTrendPill` on /adherence/escalations (item 91)
 *   - `MyAdherenceMedianTtaTrendPill` on /account (item 93, adherence self-view)
 *
 * The codebase's duplicate-at-two, extract-at-three rule (items 68 /
 * 70 / 73 / 75 / 88) was overdue: by item 93 the latency pill was on
 * five sites and items 92 + 93 both flagged the extraction as the
 * natural next consolidation pass. Bundling it into item 96 unblocks
 * a future per-Member-trend-pill-on-adherence-table item (item 88
 * analog, deferred from item 92) so it can use the shared component
 * naturally instead of becoming the sixth duplicate.
 *
 * **Latency, not rate.** The pill colour rule is INVERTED relative to
 * a rate pill: faster (delta < 0) shows ↓ green, slower (delta > 0)
 * shows ↑ red. The arrow points in the direction the number went; the
 * colour signals better-or-worse. The rate-pill family (consolidated
 * into `@/components/RateTrendPill` at item 98) uses the un-inverted
 * mapping — higher rate = better — so green/red point the opposite
 * direction.
 *
 * **Flat-band is `max(60s, 10% of prior)`** — load-bearing:
 *   - A fixed 1m absolute threshold would over-flag wobble at high
 *     values (a 4h median with 2m delta isn't a real change).
 *   - A pure relative threshold would over-flag noise at low values
 *     (a 30s median with a 4s delta is well within sampling jitter).
 *   The combined floor handles both ends. Preserved verbatim from the
 *   five original implementations — any change here moves the line
 *   for every surface at once, deliberately.
 *
 * **Renders nothing when either side is null** — matches the null-
 * prior invariant from items 72/73/75/79/81/88/91/93. Typically nulls
 * happen because no acks landed in one of the two windows, so there's
 * no median to compare; the pill simply doesn't appear rather than
 * faking a delta against missing data.
 *
 * **API**: `compact` toggles the in-table variant — drops the
 * "vs prior Nd" body suffix (the table column heading carries the
 * metric context) and shrinks padding+text-size to fit inline next to
 * a median value. The tooltip retains the full `vs prior Nd median:
 * <label> (±delta)` for hover-readable detail in either variant.
 * `className` is spread onto the pill element so each call site keeps
 * its own outer-layout class (`mt-1` to sit under a value, `ml-2` to
 * sit next to one, none to sit inline with a heading).
 */
export function MedianTtaTrendPill({
  current,
  prior,
  windowDays,
  compact = false,
  className,
}: {
  /// Current-window median in milliseconds. Null = no acks landed in
  /// the current window; the pill renders nothing.
  current: number | null;
  /// Prior-window median in milliseconds, same scope as `current`.
  /// Null = no acks landed in the prior window; the pill renders
  /// nothing rather than faking a delta against missing data.
  prior: number | null;
  /// Window length in days. Used in the body text + tooltip ("vs
  /// prior Nd"). Should match whichever window the parent surface
  /// rendered the headline numbers in (7 / 30 / 90 conventionally).
  windowDays: number;
  /// True in table cells where the column heading carries the metric
  /// context — drops "vs prior Nd" from body, smaller padding+text.
  compact?: boolean;
  /// Spread onto the pill `<span>` so each call site keeps its own
  /// outer-layout class (`mt-1` / `ml-2` / nothing).
  className?: string;
}) {
  const tone = computeMedianTtaTrendTone({ current, prior });
  if (!tone) return null;

  const priorLabel = formatDuration(prior!);
  const deltaLabel = formatDuration(Math.abs(tone.deltaMs));
  const title = `vs prior ${windowDays}d median: ${priorLabel} (${tone.directionWord}${deltaLabel})`;

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
        {tone.directionWord}
        {deltaLabel}
        {compact ? "" : ` vs prior ${windowDays}d`}
      </span>
    </span>
  );
}

/**
 * Pure decision logic for the pill — separated out so tests can pin
 * the arithmetic + flat-band + colour-inversion rules without
 * rendering React. The component above is a thin wrapper that adds
 * formatting + JSX.
 *
 * Returns null when either side of the comparison is missing (the
 * "no fake delta against missing data" invariant — items 72/73/75/79
 * /81/88/91/93). Otherwise returns the arrow, tone class, signed
 * delta, direction symbol, and flat-band value used for the call.
 *
 * Exported so tests can assert: null on either-null; "↓" + emerald
 * when faster by more than the flat band; "↑" + red when slower by
 * more than the flat band; "→" + grey when inside the flat band.
 */
export function computeMedianTtaTrendTone(input: {
  current: number | null;
  prior: number | null;
}): null | {
  arrow: "↑" | "↓" | "→";
  toneCls: string;
  deltaMs: number;
  directionWord: "+" | "−" | "±";
  flatBandMs: number;
} {
  if (input.current === null || input.prior === null) return null;
  const ABS_FLOOR_MS = 60_000;
  const REL_THRESHOLD = 0.1;
  const flatBandMs = Math.max(
    ABS_FLOOR_MS,
    Math.round(input.prior * REL_THRESHOLD),
  );
  const deltaMs = input.current - input.prior;

  let arrow: "↑" | "↓" | "→" = "→";
  let toneCls = "border-ink/20 bg-ink/5 text-ink/70";
  if (deltaMs < -flatBandMs) {
    arrow = "↓";
    toneCls = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else if (deltaMs > flatBandMs) {
    arrow = "↑";
    toneCls = "border-red-300 bg-red-50 text-red-900";
  }
  const directionWord: "+" | "−" | "±" =
    deltaMs > 0 ? "+" : deltaMs < 0 ? "−" : "±";
  return { arrow, toneCls, deltaMs, directionWord, flatBandMs };
}
