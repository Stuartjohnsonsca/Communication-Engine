import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import {
  computePriorPeriodSentimentMetrics,
  computeSentimentMetrics,
  formatTtaDuration,
  type SentimentMetrics,
} from "@/lib/sentiment/metrics";
import AcknowledgeButton from "./AcknowledgeButton";

type Filter = "ALL" | "ESCALATED" | "EXTREME_NEG" | "EXTREME_POS" | "NEUTRAL";
const FILTERS: Filter[] = ["ESCALATED", "EXTREME_NEG", "EXTREME_POS", "NEUTRAL", "ALL"];

const FILTER_LABEL: Record<Filter, string> = {
  ESCALATED: "Escalated",
  EXTREME_NEG: "Extreme negative",
  EXTREME_POS: "Extreme positive",
  NEUTRAL: "Neutral",
  ALL: "All",
};

const CLASS_LABEL: Record<string, string> = {
  EXTREME_NEG: "extreme negative",
  EXTREME_POS: "extreme positive",
  NEUTRAL: "neutral",
};

const CLASS_BG: Record<string, string> = {
  EXTREME_NEG: "bg-red-100 text-red-700",
  EXTREME_POS: "bg-emerald-100 text-emerald-800",
  NEUTRAL: "bg-ink/10 text-ink/60",
};

function parseFilter(v: string | undefined): Filter {
  if (v && (FILTERS as string[]).includes(v)) return v as Filter;
  return "ESCALATED";
}

export default async function SentimentPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { tenantSlug } = await params;
  const { filter: filterRaw } = await searchParams;
  const filter = parseFilter(filterRaw);

  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  // FCT/Admin see firm-wide; everyone else sees only signals routed to them.
  const firmWide = hasPermission(ctx.membership.role, "members:read");

  const baseWhere = {
    tenantId: ctx.tenant.id,
    ...(firmWide ? {} : { assignedToMembershipId: ctx.membership.id }),
  };

  const filterWhere =
    filter === "ALL"
      ? {}
      : filter === "ESCALATED"
        ? { escalatedAt: { not: null } }
        : { classification: filter };

  const [signals, counts, escalatedCount, metrics, priorMetrics] = await Promise.all([
    superDb.sentimentSignal.findMany({
      where: { ...baseWhere, ...filterWhere },
      orderBy: [{ escalatedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        ingestedMessage: {
          select: {
            id: true,
            sender: true,
            subject: true,
            body: true,
            sentAt: true,
            drafts: { select: { id: true, subject: true }, orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
        assignedTo: { include: { user: { select: { email: true, name: true } } } },
        acknowledgedBy: { include: { user: { select: { email: true, name: true } } } },
      },
    }),
    superDb.sentimentSignal.groupBy({
      by: ["classification"],
      where: baseWhere,
      _count: { _all: true },
    }),
    superDb.sentimentSignal.count({
      where: { ...baseWhere, escalatedAt: { not: null }, acknowledgedAt: null },
    }),
    // Item 78 — response-time metrics for the last 30d. Scope mirrors
    // the page's existing firmWide split: firm-wide for FCT/Admin,
    // self-scoped otherwise. Default window matches /admin/drafts and
    // /account so the surfaces speak the same period.
    computeSentimentMetrics({
      tenantId: ctx.tenant.id,
      windowDays: 30,
      ...(firmWide
        ? {}
        : { assignedToMembershipId: ctx.membership.id }),
    }),
    // Item 79 — prior 30d snapshot for the trend pills. Same scope as
    // `metrics` so current/prior speak the same view. Empty prior →
    // pills render nothing (don't fake a delta against missing data,
    // same null-prior invariant as items 72/73/75).
    computePriorPeriodSentimentMetrics({
      tenantId: ctx.tenant.id,
      windowDays: 30,
      ...(firmWide
        ? {}
        : { assignedToMembershipId: ctx.membership.id }),
    }),
  ]);

  const countMap: Record<string, number> = {};
  for (const c of counts) countMap[c.classification] = c._count._all;

  const totals: Record<Filter, number> = {
    ESCALATED: escalatedCount,
    EXTREME_NEG: countMap.EXTREME_NEG ?? 0,
    EXTREME_POS: countMap.EXTREME_POS ?? 0,
    NEUTRAL: countMap.NEUTRAL ?? 0,
    ALL: Object.values(countMap).reduce((a, b) => a + b, 0),
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sentiment monitoring</h1>
        <span className="text-xs text-ink/50">
          {firmWide ? "firm-wide view" : "signals routed to you"}
        </span>
      </div>
      <p className="text-xs text-ink/60">
        PRD §9.3 — boundary detector for counterparty dissatisfaction <em>with the firm&rsquo;s
        handling of the matter</em>. General displeasure with their own outcomes is not flagged.
        Negatives that clear the confidence bar are escalated to the assigned User and to the FCT.
      </p>

      <SentimentResponseTimeCard metrics={metrics} prior={priorMetrics} />

      <div className="flex flex-wrap gap-1 text-xs">
        {FILTERS.map((f) => {
          const active = f === filter;
          return (
            <Link
              key={f}
              href={`/${tenantSlug}/sentiment?filter=${f}`}
              className={`tag ${active ? "bg-ink text-white" : "bg-ink/5 hover:bg-ink/10"}`}
            >
              {FILTER_LABEL[f]} <span className="ml-1 tabular-nums opacity-70">{totals[f]}</span>
            </Link>
          );
        })}
      </div>

      {signals.length === 0 ? (
        <div className="card text-sm text-ink/60">
          No signals match this filter.
          {filter === "ESCALATED" && " Outstanding negatives requiring action will appear here."}
        </div>
      ) : (
        <div className="space-y-3">
          {signals.map((s) => {
            const cls = s.classification;
            const conf = s.confidence == null ? null : Math.round(s.confidence * 100);
            const draft = s.ingestedMessage?.drafts[0];
            const isEsc = !!s.escalatedAt;
            const isAck = !!s.acknowledgedAt;
            const evidenceSpans =
              (s.evidence as { spans?: { text: string }[] } | null)?.spans ?? [];
            return (
              <div
                key={s.id}
                className={`card space-y-2 ${
                  isEsc && !isAck ? "border-red-300" : ""
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`tag ${CLASS_BG[cls] ?? ""}`}>{CLASS_LABEL[cls] ?? cls}</span>
                    {s.isAboutFirmHandling && (
                      <span className="tag bg-amber-100 text-amber-800">about firm handling</span>
                    )}
                    {isEsc && !isAck && (
                      <span className="tag bg-red-200 text-red-800">escalated</span>
                    )}
                    {isAck && <span className="tag bg-ink/10">acknowledged</span>}
                    {conf != null && (
                      <span className="text-xs text-ink/50 tabular-nums">{conf}% confidence</span>
                    )}
                    {s.trigger && (
                      <span className="text-xs text-ink/60">trigger: {s.trigger}</span>
                    )}
                  </div>
                  <div className="text-xs text-ink/50">
                    {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </div>
                </div>

                {s.ingestedMessage && (
                  <div className="text-xs text-ink/60">
                    {s.ingestedMessage.sender && <>from {s.ingestedMessage.sender} · </>}
                    <span className="font-medium">
                      {s.ingestedMessage.subject ?? "(no subject)"}
                    </span>
                  </div>
                )}

                {evidenceSpans.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {evidenceSpans.slice(0, 3).map((sp, i) => (
                      <li key={i} className="rounded bg-ink/5 p-2 italic text-ink/80">
                        &ldquo;{sp.text}&rdquo;
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/60">
                  <div className="flex flex-wrap gap-3">
                    {firmWide && s.assignedTo && (
                      <span>
                        assigned to{" "}
                        <span className="font-medium">
                          {s.assignedTo.user.name ?? s.assignedTo.user.email}
                        </span>
                      </span>
                    )}
                    {draft && (
                      <Link
                        className="underline decoration-dotted"
                        href={`/${tenantSlug}/drafts/${draft.id}`}
                      >
                        view draft →
                      </Link>
                    )}
                    {isAck && s.acknowledgedBy && (
                      <span>
                        acked by {s.acknowledgedBy.user.name ?? s.acknowledgedBy.user.email}{" "}
                        {s.acknowledgedAt
                          ?.toISOString()
                          .slice(0, 16)
                          .replace("T", " ")}
                      </span>
                    )}
                  </div>
                  {isEsc && !isAck && (
                    <AcknowledgeButton tenantSlug={tenantSlug} signalId={s.id} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Post-PRD hardening item 78 — response-time observability card.
 *
 * Sits above the filter chips so the operator reads "how fast are we
 * responding" before drilling into individual signals. Scope is set
 * by the parent (`computeSentimentMetrics` with or without
 * `assignedToMembershipId`); the card itself is scope-agnostic.
 *
 * Renders nothing when there are zero escalated signals in the
 * window — a sentiment-quiet tenant doesn't need a "—" card cluttering
 * the page. Pairs with item 77's 4h stale-nudge: oldest-unacked
 * crossing 4h is the same boundary that fires the nudge, so the card
 * gives the operator visibility on what's about to alert.
 *
 * Item 79 — `prior` carries the same metrics shape for the
 * immediately-prior same-length window. The tiles for `Acknowledged`
 * and `Median TTA` render a trend pill underneath the value when
 * comparison data is available. P90 and Oldest-unacked deliberately
 * DON'T get pills: P90 is too noisy at low N to convey direction, and
 * oldest-unacked is a point-in-time gauge (prior-window unacked rolls
 * into current-window unacked unless it was acked, so a "trend" reads
 * confusingly).
 */
function SentimentResponseTimeCard({
  metrics,
  prior,
}: {
  metrics: SentimentMetrics;
  prior: SentimentMetrics;
}) {
  if (metrics.escalated === 0) return null;

  const ratePct =
    metrics.acknowledgedRate === null
      ? "—"
      : `${Math.round(metrics.acknowledgedRate * 100)}%`;
  const unackedTone =
    metrics.oldestUnackedMs !== null && metrics.oldestUnackedMs > 4 * 60 * 60_000
      ? "text-red-900 font-medium"
      : "text-ink/80";

  return (
    <div className="card space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Response time</h2>
        <span className="text-xs text-ink/50">
          last {metrics.windowDays} days
        </span>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wider text-ink/50">
            Acknowledged
          </dt>
          <dd className="font-medium">
            {ratePct}
            <span className="ml-1 text-[11px] font-normal text-ink/50">
              ({metrics.acknowledged}/{metrics.escalated})
            </span>
          </dd>
          <AckRateTrendPill
            current={metrics.acknowledgedRate}
            prior={prior.acknowledgedRate}
            priorEscalated={prior.escalated}
            windowDays={metrics.windowDays}
          />
        </div>
        <div>
          <dt
            className="text-xs uppercase tracking-wider text-ink/50"
            title="Median time from escalation to acknowledgement, over acked signals only."
          >
            Median TTA
          </dt>
          <dd className="font-medium">{formatTtaDuration(metrics.medianAckMs)}</dd>
          <MedianTtaTrendPill
            current={metrics.medianAckMs}
            prior={prior.medianAckMs}
            windowDays={metrics.windowDays}
          />
        </div>
        <div>
          <dt
            className="text-xs uppercase tracking-wider text-ink/50"
            title="P90 time-to-acknowledge — long-tail signal. A small median with a large P90 means most are fast but some sit."
          >
            P90 TTA
          </dt>
          <dd className="font-medium">{formatTtaDuration(metrics.p90AckMs)}</dd>
        </div>
        <div>
          <dt
            className="text-xs uppercase tracking-wider text-ink/50"
            title="Oldest still-unacked escalation in window. Red past 4h (the stale-warn threshold)."
          >
            Oldest unacked
          </dt>
          <dd className={unackedTone}>
            {formatTtaDuration(metrics.oldestUnackedMs)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Post-PRD item 79 — acknowledged-rate trend pill. Mirrors items
 * 72/73's adherence pill: percentage-point delta, 1pp flat threshold,
 * green up / red down / grey flat. Up = good (acked more), so same
 * arrow/color mapping as the adherence pill.
 *
 * Null on either side, or zero prior escalations, renders nothing —
 * matches the null-prior invariant (no fake delta against missing
 * data). A tenant with prior escalations === 0 has no comparable rate;
 * the pill simply doesn't appear.
 */
function AckRateTrendPill({
  current,
  prior,
  priorEscalated,
  windowDays,
}: {
  current: number | null;
  prior: number | null;
  priorEscalated: number;
  windowDays: number;
}) {
  if (current === null || prior === null || priorEscalated === 0) {
    return null;
  }
  const FLAT_THRESHOLD = 0.01;
  const delta = current - prior;
  const deltaPp = Math.round(delta * 100);
  const priorPct = Math.round(prior * 100);
  const title = `vs prior ${windowDays}d: ${priorPct}% acked (${deltaPp >= 0 ? "+" : ""}${deltaPp}pp)`;

  let arrow = "→";
  let cls = "border-ink/20 bg-ink/5 text-ink/70";
  if (delta > FLAT_THRESHOLD) {
    arrow = "↑";
    cls = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else if (delta < -FLAT_THRESHOLD) {
    arrow = "↓";
    cls = "border-red-300 bg-red-50 text-red-900";
  }
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
      title={title}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>
        {deltaPp >= 0 ? "+" : ""}
        {deltaPp}pp vs prior {windowDays}d
      </span>
    </span>
  );
}

/**
 * Post-PRD item 79 — median-TTA trend pill. The colour inversion is
 * deliberate: for latency metrics, lower is better. Faster (delta < 0)
 * shows ↓ green; slower (delta > 0) shows ↑ red. The arrow points in
 * the direction the number went, but the colour signals
 * better-or-worse — the same accessibility pattern the rest of the
 * codebase uses on rate pills, just with the good direction inverted.
 *
 * Flat threshold is relative: |delta| < max(60s, 10% of prior). A
 * fixed 1m absolute threshold would over-flag wobble at high values
 * (a 4h median with 2m delta isn't a real change), and a pure relative
 * threshold would over-flag noise at low values (a 30s median with a
 * 4s delta is well within sampling jitter). The combined floor handles
 * both ends.
 *
 * Renders nothing when either side is null — typically because no
 * signals were acked in one of the windows, so there's no median to
 * compare. Same null-prior invariant as items 72/73/75.
 */
function MedianTtaTrendPill({
  current,
  prior,
  windowDays,
}: {
  current: number | null;
  prior: number | null;
  windowDays: number;
}) {
  if (current === null || prior === null) return null;
  const ABS_FLOOR_MS = 60_000;
  const REL_THRESHOLD = 0.1;
  const flatBand = Math.max(ABS_FLOOR_MS, Math.round(prior * REL_THRESHOLD));
  const delta = current - prior;
  const priorLabel = formatTtaDuration(prior);
  const deltaLabel = formatTtaDuration(Math.abs(delta));
  const directionWord = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const title = `vs prior ${windowDays}d median: ${priorLabel} (${directionWord}${deltaLabel})`;

  let arrow = "→";
  let cls = "border-ink/20 bg-ink/5 text-ink/70";
  if (delta < -flatBand) {
    arrow = "↓";
    cls = "border-emerald-300 bg-emerald-50 text-emerald-900";
  } else if (delta > flatBand) {
    arrow = "↑";
    cls = "border-red-300 bg-red-50 text-red-900";
  }
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
      title={title}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>
        {directionWord}
        {deltaLabel} vs prior {windowDays}d
      </span>
    </span>
  );
}
