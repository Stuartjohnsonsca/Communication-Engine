import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import {
  computeDraftRollup,
  type DraftRollup,
  type DraftRollupWindow,
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

  const rollup = await computeDraftRollup({
    tenantId: ctx.tenant.id,
    windowDays,
  });

  const topMemberIds = rollup.byMembership.map((m) => m.membershipId);
  const memberships = topMemberIds.length
    ? await superDb.membership.findMany({
        where: { id: { in: topMemberIds } },
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

      <nav className="flex items-center gap-2 text-sm">
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
        <h2 className="text-base font-medium">FCG-window adherence</h2>
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
                      {pct(m.fcgWindow.withinWindowRate)}
                      {m.fcgWindow.sentWithDeadline > 0 && (
                        <span className="ml-1 text-[11px] font-normal text-ink/50">
                          ({num(m.fcgWindow.sentWithinWindow)}/{num(m.fcgWindow.sentWithDeadline)})
                        </span>
                      )}
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
