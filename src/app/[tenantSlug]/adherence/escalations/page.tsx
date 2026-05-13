import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { ADHERENCE_ESCALATION_THRESHOLD } from "@/lib/adherence/escalation";
import {
  computeAdherenceMetrics,
  computePriorPeriodAdherenceMetrics,
  type AdherenceMetrics,
} from "@/lib/adherence/metrics";
import { formatDuration, formatDurationOrDash } from "@/lib/format/duration";
import AcknowledgeButton from "./AcknowledgeButton";

type Filter = "OPEN" | "ALL" | "ACKNOWLEDGED";
const FILTERS: Filter[] = ["OPEN", "ACKNOWLEDGED", "ALL"];

const FILTER_LABEL: Record<Filter, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  ALL: "All escalations",
};

function parseFilter(v: string | undefined): Filter {
  if (v && (FILTERS as string[]).includes(v)) return v as Filter;
  return "OPEN";
}

type RuleFinding = { ruleExternalId: string; source: string; verdict: string; explanation: string };

export default async function AdherenceEscalationsPage({
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
  requirePermission(ctx.membership.role, "adherence:read");

  // FCT/Admin see firm-wide; everyone else sees only escalations on
  // sends attributed to them.
  const firmWide = hasPermission(ctx.membership.role, "members:read");
  // Item 89 — uncapped per-escalation CSV export is firm-wide
  // governance evidence. Same gate as `firmWide` today (FIRM_ADMIN +
  // FCT_MEMBER) but a separate permission so a future policy change
  // can split list-view from export rights without touching the page
  // logic. Mirrors item 83's `sentiment:export` shape.
  const canExport = hasPermission(ctx.membership.role, "adherence:export");

  const baseWhere = {
    tenantId: ctx.tenant.id,
    escalatedAt: { not: null },
    ...(firmWide ? {} : { membershipId: ctx.membership.id }),
  };
  const filterWhere =
    filter === "ALL"
      ? {}
      : filter === "OPEN"
        ? { acknowledgedAt: null }
        : { acknowledgedAt: { not: null } };

  const [rows, openCount, ackCount, allCount, metrics, priorMetrics] = await Promise.all([
    superDb.communicationAdherence.findMany({
      where: { ...baseWhere, ...filterWhere },
      orderBy: [{ escalatedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        draft: {
          select: {
            id: true,
            subject: true,
            channel: true,
            sentMarkedAt: true,
            synthesisedFromOutboundIngest: true,
            inboundSender: true,
          },
        },
        membership: { include: { user: { select: { email: true, name: true } } } },
        acknowledgedBy: { include: { user: { select: { email: true, name: true } } } },
      },
    }),
    superDb.communicationAdherence.count({ where: { ...baseWhere, acknowledgedAt: null } }),
    superDb.communicationAdherence.count({ where: { ...baseWhere, acknowledgedAt: { not: null } } }),
    superDb.communicationAdherence.count({ where: baseWhere }),
    // Item 90 — response-time metrics for the last 30d. Scope mirrors
    // the page's existing firmWide split: firm-wide for FCT/Admin,
    // self-scoped otherwise. Default window matches /sentiment /
    // /admin/drafts / /account so the surfaces speak the same period.
    computeAdherenceMetrics({
      tenantId: ctx.tenant.id,
      windowDays: 30,
      ...(firmWide ? {} : { membershipId: ctx.membership.id }),
    }),
    // Item 91 — prior 30d snapshot for the trend pills. Same scope as
    // `metrics` so current/prior speak the same view. Empty prior →
    // pills render nothing (don't fake a delta against missing data,
    // same null-prior invariant as items 72/73/75/79/88).
    computePriorPeriodAdherenceMetrics({
      tenantId: ctx.tenant.id,
      windowDays: 30,
      ...(firmWide ? {} : { membershipId: ctx.membership.id }),
    }),
  ]);

  const totals: Record<Filter, number> = { OPEN: openCount, ACKNOWLEDGED: ackCount, ALL: allCount };
  const thresholdPct = Math.round(ADHERENCE_ESCALATION_THRESHOLD * 100);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Adherence escalations</h1>
        <div className="flex items-baseline gap-3">
          {/* Item 89 — uncapped per-escalation CSV. Only rendered when
              the operator both has the permission AND there are
              escalations to export — a quiet tenant doesn't see a
              "download nothing" link. Window matches the firm
              compliance defaults (30d) shared with /sentiment + /admin
              /drafts exports for consistency. */}
          {canExport && allCount > 0 && (
            <a
              href={`/api/admin/adherence/export?tenant=${tenantSlug}&window=30`}
              className="text-xs underline decoration-dotted text-ink/60 hover:text-ink"
              title="Download every escalation in the last 30 days with full ack metadata. Acknowledged + open-overdue, uncapped."
            >
              Export CSV (30d)
            </a>
          )}
          <span className="text-xs text-ink/50">
            {firmWide ? "firm-wide view" : "your sends only"}
          </span>
        </div>
      </div>
      <p className="text-xs text-ink/60">
        PRD §9.1 + post-PRD compliance gate. Every observed outbound communication is scored against the
        FCG / UCG used at the time. Sends scoring below {thresholdPct}% overall escalate to the User and
        the FCT — whether the send went through the drafting UI or bypassed it via the connected mailbox.
      </p>

      <AdherenceResponseTimeCard metrics={metrics} prior={priorMetrics} />


      <div className="flex flex-wrap gap-1 text-xs">
        {FILTERS.map((f) => {
          const active = f === filter;
          return (
            <Link
              key={f}
              href={`/${tenantSlug}/adherence/escalations?filter=${f}`}
              className={`tag ${active ? "bg-ink text-white" : "bg-ink/5 hover:bg-ink/10"}`}
            >
              {FILTER_LABEL[f]} <span className="ml-1 tabular-nums opacity-70">{totals[f]}</span>
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="card text-sm text-ink/60">
          No escalations match this filter.
          {filter === "OPEN" && " Outstanding poor-adherence sends will appear here."}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const overallPct = Math.round(r.overall * 100);
            const isAck = !!r.acknowledgedAt;
            const findings = ((r.perRule ?? []) as RuleFinding[]).filter((f) => f.verdict === "fail");
            return (
              <div
                key={r.id}
                className={`card space-y-2 ${isAck ? "" : "border-red-300"}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="tag bg-red-100 text-red-700">{overallPct}% overall</span>
                    <span className="tag bg-ink/5">{r.draft.channel}</span>
                    {r.draft.synthesisedFromOutboundIngest && (
                      <span className="tag bg-amber-100 text-amber-800">bypassed send</span>
                    )}
                    {!isAck && <span className="tag bg-red-200 text-red-800">open</span>}
                    {isAck && <span className="tag bg-ink/10">acknowledged</span>}
                    <span className="text-xs text-ink/60">
                      FCG v{r.fcgVersionUsed}
                      {r.ucgVersionUsed != null && ` · UCG v${r.ucgVersionUsed}`}
                    </span>
                  </div>
                  <div className="text-xs text-ink/50">
                    {(r.escalatedAt ?? r.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                  </div>
                </div>

                <div className="text-xs text-ink/70">
                  <span className="font-medium">
                    {r.draft.subject ?? "(no subject)"}
                  </span>
                  {r.draft.inboundSender && <> · in reply to {r.draft.inboundSender}</>}
                </div>

                {findings.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {findings.slice(0, 3).map((f, i) => (
                      <li key={i} className="rounded bg-red-50 p-2">
                        <span className="font-mono text-ink/60">
                          {f.source}:{f.ruleExternalId}
                        </span>
                        <div className="text-ink/80">{f.explanation}</div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/60">
                  <div className="flex flex-wrap gap-3">
                    {firmWide && (
                      <span>
                        sender{" "}
                        <span className="font-medium">
                          {r.membership.user.name ?? r.membership.user.email}
                        </span>
                      </span>
                    )}
                    <Link
                      className="underline decoration-dotted"
                      href={`/${tenantSlug}/drafts/${r.draftId}`}
                    >
                      view sent draft →
                    </Link>
                    {isAck && r.acknowledgedBy && (
                      <span>
                        acked by {r.acknowledgedBy.user.name ?? r.acknowledgedBy.user.email}{" "}
                        {r.acknowledgedAt
                          ?.toISOString()
                          .slice(0, 16)
                          .replace("T", " ")}
                      </span>
                    )}
                  </div>
                  {!isAck && <AcknowledgeButton tenantSlug={tenantSlug} adherenceId={r.id} />}
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
 * Post-PRD items 90 + 91 — adherence response-time card with trend pills.
 *
 * Adherence-pillar analog of item 78's `SentimentResponseTimeCard` + item
 * 79's trend pills. Same four-tile layout (Acknowledged / Median TTA /
 * P90 TTA / Oldest unacked), same null-when-no-data rules, same 4h-stale
 * red-tone on `Oldest unacked` — operator mental model is "4h = bad"
 * everywhere across response-time gauges.
 *
 * Renders nothing when `escalated === 0` — a clean-adherence tenant
 * doesn't need a "—" card cluttering the page. The list section below
 * already prints "No escalations match this filter" in that state.
 *
 * Item 91 — Acknowledged AND Median TTA both carry a trend pill against
 * the immediately-prior same-length window. P90 + Oldest unacked
 * deliberately don't get pills (P90 is noisy at typical N, Oldest
 * unacked is a point-in-time gauge — same exclusions as item 79).
 * Per-Member breakdown deliberately omitted; that'd be a separate item
 * mirroring item 80.
 */
function AdherenceResponseTimeCard({
  metrics,
  prior,
}: {
  metrics: AdherenceMetrics;
  prior: AdherenceMetrics;
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
          <AdherenceAckRateTrendPill
            current={metrics.acknowledgedRate}
            prior={prior.acknowledgedRate}
            priorEscalated={prior.escalated}
            windowDays={metrics.windowDays}
          />
        </div>
        <div>
          <dt
            className="text-xs uppercase tracking-wider text-ink/50"
            title="Median time from escalation to acknowledgement, over acked escalations only."
          >
            Median TTA
          </dt>
          <dd className="font-medium">
            {formatDurationOrDash(metrics.medianAckMs)}
          </dd>
          <AdherenceMedianTtaTrendPill
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
          <dd className="font-medium">
            {formatDurationOrDash(metrics.p90AckMs)}
          </dd>
        </div>
        <div>
          <dt
            className="text-xs uppercase tracking-wider text-ink/50"
            title="Oldest still-unacked escalation in window. Red past 4h."
          >
            Oldest unacked
          </dt>
          <dd className={unackedTone}>
            {formatDurationOrDash(metrics.oldestUnackedMs)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Post-PRD item 91 — acknowledged-rate trend pill on the adherence card.
 * Sibling of item 79's sentiment-side `AckRateTrendPill`: percentage-
 * point delta vs prior same-length window, 1pp flat band, ↑green = good
 * (acked more), ↓red = bad. Renders nothing when current or prior is
 * null, or when prior had zero escalations — don't fake a delta against
 * missing data. Same null-prior invariant as items 72/73/75/79/88.
 */
function AdherenceAckRateTrendPill({
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
  if (current === null || prior === null || priorEscalated === 0) return null;
  const FLAT_THRESHOLD = 0.01;
  const delta = current - prior;
  const deltaPp = Math.round(delta * 100);
  const priorPct = Math.round(prior * 100);
  const title = `vs prior ${windowDays}d: ${priorPct}% (${deltaPp >= 0 ? "+" : ""}${deltaPp}pp)`;

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
 * Post-PRD item 91 — median-TTA trend pill on the adherence card.
 * Sibling of item 79's sentiment-side `MedianTtaTrendPill`: inverted
 * colour rule (lower latency is BETTER, so faster=↓green, slower=↑red),
 * `max(60s, 10% of prior)` flat band so neither absolute jitter at high
 * values nor sampling noise at low values trips the colour change.
 *
 * Renders nothing when either side is null — typically because zero
 * escalations were acked in one of the windows, so there's no median to
 * compare. Same null-prior invariant as items 72/73/75/79/88.
 */
function AdherenceMedianTtaTrendPill({
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
  const priorLabel = formatDuration(prior);
  const deltaLabel = formatDuration(Math.abs(delta));
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

