import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import {
  computeDraftRollup,
  computePriorPeriodFcgRate,
  type DraftRollup,
  type DraftRollupWindow,
  type FcgMissRow,
  type SourceBucket,
} from "@/lib/drafts/rollup";

/**
 * Post-PRD hardening item 56 — draft outcome rollup.
 *
 * Sister page to /admin/usage (item 55). Same shape: one page per
 * tenant, default 30-day window, FIRM_ADMIN + FCT_MEMBER. The FCT is
 * included because acceptance/bypass rates are governance signals (is
 * the FCG actually producing on-promise drafts?) and the rollup
 * contains no commercial data. Cost stays on /admin/usage.
 */

const WINDOWS: DraftRollupWindow[] = [7, 30, 90];

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function num(n: number): string {
  return n.toLocaleString("en-GB");
}

function minutes(n: number | null): string {
  if (n === null) return "—";
  if (n < 60) return `${n} min`;
  if (n < 60 * 24) return `${(n / 60).toFixed(1)} h`;
  return `${(n / (60 * 24)).toFixed(1)} d`;
}

const SOURCE_LABEL: Record<keyof DraftRollup["bySource"], string> = {
  ingested: "Channel-ingested",
  manual_paste: "Manual paste",
  bypassed_synth: "Bypassed (post-hoc synth)",
};

const SOURCE_DESCRIPTION: Record<keyof DraftRollup["bySource"], string> = {
  ingested:
    "Inbound arrived via an authorised channel; engine produced the draft (cron or User-triggered).",
  manual_paste:
    "User pasted raw email text into /drafts/new — outside of channel ingestion.",
  bypassed_synth:
    "User sent an email without using the engine; the outbound was synthesised after the fact for adherence scoring. High bypass = engine is decorative.",
};

export default async function DraftsRollupPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { tenantSlug } = await params;
  const { window: windowParam } = await searchParams;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "drafts:read-rollup")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const parsedWindow = Number(windowParam);
  const windowDays: DraftRollupWindow =
    WINDOWS.includes(parsedWindow as DraftRollupWindow)
      ? (parsedWindow as DraftRollupWindow)
      : 30;

  const [rollup, priorPeriod] = await Promise.all([
    computeDraftRollup({
      tenantId: ctx.tenant.id,
      windowDays,
    }),
    // Item 72 — trend pill. Same-length window immediately prior so a
    // FIRM_ADMIN can answer "are we trending up or down?" alongside
    // the snapshot rate. Independent query (no shared rollup) so the
    // CSV export + adherence-monitor cron stay unchanged.
    computePriorPeriodFcgRate({
      tenantId: ctx.tenant.id,
      windowDays,
    }),
  ]);

  // Top-drafters table + item 74's recent-misses panel both need
  // human-readable member labels. Union the two ID sets and resolve in
  // a single query rather than two round trips.
  const memberIdSet = new Set<string>(
    rollup.byMembership.map((m) => m.membershipId),
  );
  for (const r of rollup.fcgWindow.recentMisses.sentAfterWindow) {
    if (r.membershipId) memberIdSet.add(r.membershipId);
  }
  for (const r of rollup.fcgWindow.recentMisses.openOverdue) {
    if (r.membershipId) memberIdSet.add(r.membershipId);
  }
  const memberIds = Array.from(memberIdSet);
  const memberships = memberIds.length
    ? await superDb.membership.findMany({
        where: { id: { in: memberIds } },
        include: { user: { select: { email: true, name: true } } },
      })
    : [];
  const memberLabel = new Map<string, string>(
    memberships.map((m) => [m.id, m.user.name ?? m.user.email ?? m.id]),
  );

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Draft outcomes</h1>
        <p className="text-sm text-ink/60">
          Is the engine producing drafts that get used? Acceptance, bypass and
          regeneration rates over the selected window — paired with{" "}
          <Link
            href={`/${tenantSlug}/admin/usage`}
            className="underline decoration-dotted"
          >
            /admin/usage
          </Link>
          {" "}for the matching cost view.
        </p>
      </header>

      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink/60">Window:</span>
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`?window=${w}`}
            className={`rounded border px-2 py-1 ${
              w === windowDays
                ? "border-ink bg-ink text-white"
                : "border-ink/20 hover:bg-ink/5"
            }`}
          >
            {w} days
          </Link>
        ))}
        <a
          href={`/api/admin/drafts/export?tenant=${tenantSlug}&window=${windowDays}`}
          className="ml-auto rounded border border-ink/20 px-2 py-1 hover:bg-ink/5"
        >
          Download CSV
        </a>
      </nav>

      <section className="card grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Field label="Drafts produced" value={num(rollup.totals.produced)} />
        <Field label="Sent" value={num(rollup.totals.sent)} />
        <Field label="Discarded" value={num(rollup.totals.discarded)} />
        <Field label="Open" value={num(rollup.totals.open)} />
        <Field
          label="Send rate"
          value={pct(rollup.sendRate)}
          hint="Of drafts that reached a terminal status, the proportion sent."
        />
        <Field
          label="Bypass rate"
          value={pct(rollup.bypassRate)}
          hint="Of all sends, how many bypassed the engine (post-hoc synthesised)."
        />
        <Field
          label="Regeneration rate"
          value={pct(rollup.regeneration.rate)}
          hint="Drafts that are themselves regenerations of an earlier draft."
        />
        <Field
          label="Avg produced→sent"
          value={minutes(rollup.latency.avgProducedToSentMin)}
          hint="Wall-clock time between draft creation and the User marking it sent."
        />
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-medium">FCG-window adherence</h2>
          <AdherenceTrendPill
            current={rollup.fcgWindow.withinWindowRate}
            prior={priorPeriod.withinWindowRate}
            priorSentWithDeadline={priorPeriod.sentWithDeadline}
            windowDays={windowDays}
          />
        </div>
        <p className="text-xs text-ink/60">
          The engine&apos;s central promise is &ldquo;respond within the FCG
          window.&rdquo; This is the firm-wide view of whether sent drafts
          beat their deadlines. Bypassed-synth drafts and drafts with no
          deadline are excluded (no promise was made). Pairs with the
          per-Member triage view on{" "}
          <Link
            href={`/${tenantSlug}/drafts`}
            className="underline decoration-dotted"
          >
            /drafts
          </Link>
          .
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <Field
            label="Within window"
            value={pct(rollup.fcgWindow.withinWindowRate)}
            hint={`${num(rollup.fcgWindow.sentWithinWindow)}/${num(rollup.fcgWindow.sentWithDeadline)} sent on or before deadline.`}
          />
          <Field
            label="Sent after window"
            value={num(rollup.fcgWindow.sentAfterWindow)}
            hint="Late sends. The promise was made AND broken."
          />
          <Field
            label="Open + overdue"
            value={num(rollup.fcgWindow.openOverdue)}
            hint="Non-terminal drafts whose deadline has already passed — currently in breach."
          />
          <Field
            label="Deadlined sends"
            value={num(rollup.fcgWindow.sentWithDeadline)}
            hint="SENT drafts in window that had a deadline."
          />
        </div>
      </section>

      <RecentFcgMissesSection
        sentAfterWindow={rollup.fcgWindow.recentMisses.sentAfterWindow}
        openOverdue={rollup.fcgWindow.recentMisses.openOverdue}
        memberLabel={memberLabel}
        windowDays={windowDays}
        tenantSlug={tenantSlug}
      />

      <section className="card space-y-3">
        <h2 className="text-base font-medium">By draft source</h2>
        <p className="text-xs text-ink/60">
          The bypass column is the central governance signal — every send that
          appears there is a User communicating without engine oversight.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Source</th>
              <th className="py-1 pr-3">Produced</th>
              <th className="py-1 pr-3">Sent</th>
              <th className="py-1 pr-3">Discarded</th>
              <th className="py-1 pr-3">Open</th>
              <th className="py-1 pr-3">Send rate</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(rollup.bySource) as Array<keyof DraftRollup["bySource"]>).map(
              (key) => {
                const bucket: SourceBucket = rollup.bySource[key];
                const terminal = bucket.produced - bucket.open;
                const rate = terminal > 0 ? bucket.sent / terminal : null;
                return (
                  <tr key={key} className="border-t border-ink/5 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{SOURCE_LABEL[key]}</div>
                      <div className="text-xs text-ink/50">
                        {SOURCE_DESCRIPTION[key]}
                      </div>
                    </td>
                    <td className="py-2 pr-3">{num(bucket.produced)}</td>
                    <td className="py-2 pr-3">{num(bucket.sent)}</td>
                    <td className="py-2 pr-3">{num(bucket.discarded)}</td>
                    <td className="py-2 pr-3">{num(bucket.open)}</td>
                    <td className="py-2 pr-3 font-medium">{pct(rate)}</td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Regeneration</h2>
        <p className="text-xs text-ink/60">
          Every regenerate clicks discards the prior draft and creates a new
          row linked via <code className="text-xs">parentId</code>. High
          regeneration is a quality signal — the first attempt is missing
          something a User keeps adding back.
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Field
            label="Regenerated drafts"
            value={num(rollup.regeneration.childDrafts)}
            hint="Drafts that ARE a regeneration."
          />
          <Field
            label="Distinct parents"
            value={num(rollup.regeneration.draftsRegeneratedAtLeastOnce)}
            hint="Drafts regenerated at least once."
          />
          <Field
            label="Regeneration rate"
            value={pct(rollup.regeneration.rate)}
            hint="Children / produced (period)."
          />
        </div>
      </section>

      {rollup.byMembership.length > 0 && (
        <section className="card space-y-3">
          <h2 className="text-base font-medium">Top drafters</h2>
          <p className="text-xs text-ink/60">
            The within-window column applies the same exclusions as the
            firm-wide block: bypassed-synth and no-deadline drafts don&apos;t
            count. A Member who routinely bypasses the engine can&apos;t game
            their adherence by sending the few engine drafts late.
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3">Produced</th>
                <th className="py-1 pr-3">Sent</th>
                <th className="py-1 pr-3">Discarded</th>
                <th className="py-1 pr-3">Open</th>
                <th className="py-1 pr-3">Send rate</th>
                <th className="py-1 pr-3">Within window</th>
                <th className="py-1 pr-3">Open overdue</th>
              </tr>
            </thead>
            <tbody>
              {rollup.byMembership.map((m) => {
                const terminal = m.produced - m.open;
                const rate = terminal > 0 ? m.sent / terminal : null;
                return (
                  <tr key={m.membershipId} className="border-t border-ink/5">
                    <td className="py-2 pr-3">
                      {memberLabel.get(m.membershipId) ?? m.membershipId}
                    </td>
                    <td className="py-2 pr-3">{num(m.produced)}</td>
                    <td className="py-2 pr-3">{num(m.sent)}</td>
                    <td className="py-2 pr-3">{num(m.discarded)}</td>
                    <td className="py-2 pr-3">{num(m.open)}</td>
                    <td className="py-2 pr-3 font-medium">{pct(rate)}</td>
                    <td className="py-2 pr-3 font-medium">
                      <div className="flex flex-wrap items-baseline gap-1">
                        <span>{pct(m.fcgWindow.withinWindowRate)}</span>
                        {m.fcgWindow.sentWithDeadline > 0 && (
                          <span className="text-[11px] font-normal text-ink/50">
                            ({num(m.fcgWindow.sentWithinWindow)}/{num(m.fcgWindow.sentWithDeadline)})
                          </span>
                        )}
                        {(() => {
                          // Item 75 — per-Member trend pill. Compact variant
                          // (just arrow + delta in pp; no "vs prior Nd" text)
                          // so the column doesn't blow up. Hidden when the
                          // member has no prior data, matching the firm-wide
                          // pill's null-prior invariant.
                          const prior = priorPeriod.perMember[m.membershipId];
                          if (!prior) return null;
                          return (
                            <CompactAdherenceTrendPill
                              current={m.fcgWindow.withinWindowRate}
                              prior={prior.withinWindowRate}
                              priorSentWithDeadline={prior.sentWithDeadline}
                              windowDays={windowDays}
                            />
                          );
                        })()}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {m.fcgWindow.openOverdue > 0 ? (
                        <span className="font-medium text-red-900">
                          {num(m.fcgWindow.openOverdue)}
                        </span>
                      ) : (
                        num(0)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {rollup.totals.produced === 0 && (
        <p className="text-sm text-ink/60">
          No drafts produced in the last {windowDays} days. The auto-draft cron,
          /drafts/new, and bypassed-send synthesis all populate this view once
          they execute.
        </p>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-ink/60 text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {hint && <dd className="text-[11px] text-ink/50">{hint}</dd>}
    </div>
  );
}

/**
 * Post-PRD item 74 — recent FCG-window misses panel.
 *
 * Closes the loop from items 66-73 (operator sees the rate / trend /
 * who's missing) to operator action ("these specific drafts broke the
 * promise — go act on them"). Two stacked tables: late sends in the
 * window and currently-overdue open drafts, each capped at
 * `RECENT_MISSES_LIMIT` rows ordered by lateness.
 *
 * No draft body, no link. The operator follows up out-of-band — DM
 * the Member, check email, escalate. Body content is private to the
 * Member's own /drafts inbox; the admin sees just enough to identify
 * and triage.
 */
function RecentFcgMissesSection({
  sentAfterWindow,
  openOverdue,
  memberLabel,
  windowDays,
  tenantSlug,
}: {
  sentAfterWindow: FcgMissRow[];
  openOverdue: FcgMissRow[];
  memberLabel: Map<string, string>;
  windowDays: number;
  tenantSlug: string;
}) {
  const hasAny = sentAfterWindow.length > 0 || openOverdue.length > 0;
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-medium">Recent FCG-window misses</h2>
          <p className="text-xs text-ink/60">
            Specific drafts behind the &ldquo;sent after window&rdquo; and
            &ldquo;open + overdue&rdquo; counts. Sorted most-late first —
            worst misses at the top. Body content stays private to each
            Member&apos;s own /drafts inbox.
          </p>
        </div>
        {hasAny && (
          // Item 76 — full-list CSV. The on-screen panel caps at 10
          // rows per bucket (item 74); a compliance review wants every
          // breach in the window. The link sits inside the section so
          // it reads as "download THESE rows" rather than the rollup
          // CSV link in the page header.
          <a
            href={`/api/admin/drafts/misses-export?tenant=${tenantSlug}&window=${windowDays}`}
            className="rounded border border-ink/20 px-2 py-1 text-xs hover:bg-ink/5"
          >
            Download full list (CSV)
          </a>
        )}
      </div>
      {!hasAny ? (
        <p className="text-sm text-ink/60">
          No broken FCG-window promises in the last {windowDays} days.
        </p>
      ) : null}
      <MissesTable
        heading="Sent after window"
        emptyLabel={`No late sends in the last ${windowDays} days.`}
        rows={sentAfterWindow}
        memberLabel={memberLabel}
        whenColumnLabel="Sent"
        whenAccessor={(r) => r.sentMarkedAt}
      />
      <MissesTable
        heading="Open + overdue"
        emptyLabel={`No open drafts past their deadline.`}
        rows={openOverdue}
        memberLabel={memberLabel}
        whenColumnLabel="Status"
        whenAccessor={() => null}
        showStatusInsteadOfWhen
      />
    </section>
  );
}

function MissesTable({
  heading,
  emptyLabel,
  rows,
  memberLabel,
  whenColumnLabel,
  whenAccessor,
  showStatusInsteadOfWhen,
}: {
  heading: string;
  emptyLabel: string;
  rows: FcgMissRow[];
  memberLabel: Map<string, string>;
  whenColumnLabel: string;
  whenAccessor: (r: FcgMissRow) => Date | null;
  showStatusInsteadOfWhen?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wider text-ink/50">
        {heading}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink/60">{emptyLabel}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Member</th>
              <th className="py-1 pr-3">Deadline</th>
              <th className="py-1 pr-3">{whenColumnLabel}</th>
              <th className="py-1 pr-3">Late by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label =
                (r.membershipId && memberLabel.get(r.membershipId)) ??
                r.membershipId ??
                "(no member)";
              const when = whenAccessor(r);
              return (
                <tr key={r.draftId} className="border-t border-ink/5 align-top">
                  <td className="py-2 pr-3">{label}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {formatIsoMinute(r.fcgWindowDeadline)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {showStatusInsteadOfWhen ? (
                      <span className="tag bg-amber-50 text-amber-900">
                        {r.status}
                      </span>
                    ) : when ? (
                      formatIsoMinute(when)
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-3 font-medium text-red-900">
                    {formatLateBy(r.lateMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatIsoMinute(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/// Render a positive duration as a short "Nm" / "Nh" / "Nd" string.
/// Sub-minute collapses to "<1m" so a 30-second tail doesn't read as
/// "0m late". Mirror of `formatDeadlineRelative` from triage — same
/// shape, but works on a raw ms duration rather than a deadline+now
/// pair, so it can be used for both sent-after (sentAt - deadline)
/// and open-overdue (now - deadline) without a wrapper.
function formatLateBy(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${hours}h`;
  const days = Math.round(ms / (24 * 60 * 60_000));
  return `${days}d`;
}

/**
 * Post-PRD item 75 — compact per-Member variant of the trend pill.
 *
 * Same maths as `AdherenceTrendPill` (item 72), same null-handling,
 * same 1pp flat-threshold — only the rendered text differs. Drops
 * "vs prior Nd" because the table column already carries the
 * context, leaving just an arrow and pp delta to keep the row tight.
 * The tooltip preserves the full prior% + signed delta so hovering
 * still gives the operator the same detail as the heading pill.
 */
function CompactAdherenceTrendPill({
  current,
  prior,
  priorSentWithDeadline,
  windowDays,
}: {
  current: number | null;
  prior: number | null;
  priorSentWithDeadline: number;
  windowDays: number;
}) {
  if (current === null || prior === null || priorSentWithDeadline === 0) {
    return null;
  }
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
      className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[10px] font-medium ${cls}`}
      title={title}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>
        {deltaPp >= 0 ? "+" : ""}
        {deltaPp}pp
      </span>
    </span>
  );
}

/**
 * Post-PRD item 72 — week-over-week (or selected-window-over-prior-
 * same-length-window) adherence trend pill. Rendered next to the
 * FCG-window adherence section heading so the snapshot rate is
 * always read in context of direction.
 *
 * Renders nothing when either side is null — the prior window had no
 * deadlined sends, or the current window does. The /admin/drafts
 * snapshot already shows "—" in that case; an empty pill is correct
 * (we're not faking a 0pp delta against missing data).
 *
 * `FLAT_THRESHOLD = 0.01` (1pp) collapses noise — bobbing 1pp
 * week-over-week shouldn't read as "improving" or "degrading."
 */
function AdherenceTrendPill({
  current,
  prior,
  priorSentWithDeadline,
  windowDays,
}: {
  current: number | null;
  prior: number | null;
  priorSentWithDeadline: number;
  windowDays: number;
}) {
  if (current === null || prior === null || priorSentWithDeadline === 0) {
    return null;
  }
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
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
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
