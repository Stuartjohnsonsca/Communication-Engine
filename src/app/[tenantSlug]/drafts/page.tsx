import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import {
  bucketDrafts,
  formatDeadlineRelative,
  DUE_SOON_HORIZON_HOURS,
  RECENTLY_CLOSED_HORIZON_DAYS,
} from "@/lib/drafts";

/**
 * Post-PRD hardening item 64 — FCG-deadline triage on the Member
 * drafts inbox.
 *
 * The engine's central promise is "respond within the FCG window."
 * The old page rendered a flat createdAt-DESC list, so an overdue
 * draft from yesterday and a fresh draft due in 8 hours looked the
 * same. This rewrite splits drafts into three urgency buckets
 * (overdue / due-soon / open) plus a small recently-closed tail,
 * and surfaces counts in the header so the Member sees the shape
 * of their workload before scrolling.
 *
 * Pure server-component view; no client interactivity needed for
 * the triage itself. Action buttons (regenerate, mark sent, etc.)
 * stay on the per-draft page at `/drafts/[id]`.
 */
export default async function DraftsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  // Open drafts: everything not terminal. Cap at 200 — if a Member
  // has > 200 open drafts the engine has bigger problems than UI
  // pagination. The bucket sort happens in lib so we don't constrain
  // ordering at the SQL layer.
  const openDrafts = await superDb.draft.findMany({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      status: { notIn: ["SENT", "DISCARDED"] },
    },
    take: 200,
    include: { _count: { select: { actions: true } } },
  });

  // Recently-closed: last 7d of SENT or DISCARDED. Cap at 20 so the
  // section doesn't dominate the page when the Member is keeping up.
  const since = new Date(Date.now() - RECENTLY_CLOSED_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const closedDrafts = await superDb.draft.findMany({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      status: { in: ["SENT", "DISCARDED"] },
      OR: [
        { sentMarkedAt: { gte: since } },
        // Discards have no sentMarkedAt but they're still terminal;
        // fall back to createdAt for the time filter.
        { sentMarkedAt: null, createdAt: { gte: since } },
      ],
    },
    take: 20,
    include: { _count: { select: { actions: true } } },
  });

  const now = new Date();
  const open = bucketDrafts(openDrafts, now);
  const closed = bucketDrafts(closedDrafts, now);
  const overdue = open.overdue;
  const dueSoon = open.due_soon;
  const remainingOpen = open.open;
  const recentlyClosed = closed.recently_closed;

  const totalActionable = overdue.length + dueSoon.length + remainingOpen.length;
  const inboxZero = totalActionable === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
        <Link href={`/${tenantSlug}/drafts/new`} className="btn btn-primary">
          New draft
        </Link>
      </div>

      {!inboxZero && (
        <div className="flex flex-wrap gap-3 text-xs text-ink/70">
          {overdue.length > 0 && (
            <span className="rounded bg-red-50 px-2 py-1 text-red-900">
              <strong>{overdue.length}</strong> overdue
            </span>
          )}
          {dueSoon.length > 0 && (
            <span className="rounded bg-amber-50 px-2 py-1 text-amber-900">
              <strong>{dueSoon.length}</strong> due in next {DUE_SOON_HORIZON_HOURS}h
            </span>
          )}
          {remainingOpen.length > 0 && (
            <span className="rounded bg-ink/[0.04] px-2 py-1">
              <strong>{remainingOpen.length}</strong> open
            </span>
          )}
        </div>
      )}

      {inboxZero && (
        <div className="card text-sm text-ink/70">
          <div className="text-base font-medium text-emerald-700">Inbox zero</div>
          <p className="mt-1">
            No open drafts. New inbound from your connected channels will be drafted
            automatically; you can also{" "}
            <Link className="underline" href={`/${tenantSlug}/drafts/new`}>
              paste an inbound message
            </Link>{" "}
            to draft one manually.
          </p>
        </div>
      )}

      {overdue.length > 0 && (
        <DraftSection
          title="Overdue"
          subtitle="Deadline has passed; the FCG response window is in breach."
          drafts={overdue}
          tenantSlug={tenantSlug}
          accentClass="border-l-4 border-l-red-500"
          now={now}
        />
      )}

      {dueSoon.length > 0 && (
        <DraftSection
          title={`Due in next ${DUE_SOON_HORIZON_HOURS}h`}
          subtitle="Deadline is approaching — review and send before the window closes."
          drafts={dueSoon}
          tenantSlug={tenantSlug}
          accentClass="border-l-4 border-l-amber-500"
          now={now}
        />
      )}

      {remainingOpen.length > 0 && (
        <DraftSection
          title="Open"
          subtitle="No urgency — drafts without a deadline or with > 24h remaining."
          drafts={remainingOpen}
          tenantSlug={tenantSlug}
          accentClass=""
          now={now}
        />
      )}

      {recentlyClosed.length > 0 && (
        <DraftSection
          title={`Recently closed (last ${RECENTLY_CLOSED_HORIZON_DAYS}d)`}
          subtitle="Sent or discarded — shown for context, not action."
          drafts={recentlyClosed}
          tenantSlug={tenantSlug}
          accentClass="opacity-70"
          now={now}
        />
      )}
    </div>
  );
}

type DraftRow = {
  id: string;
  subject: string | null;
  body: string;
  kind: string;
  channel: string;
  status: string;
  holdingRequired: boolean;
  researchTaskRequired: boolean;
  noGoSubjectHit: boolean;
  createdAt: Date;
  sentMarkedAt: Date | null;
  fcgWindowDeadline: Date | null;
  _count: { actions: number };
};

function DraftSection({
  title,
  subtitle,
  drafts,
  tenantSlug,
  accentClass,
  now,
}: {
  title: string;
  subtitle: string;
  drafts: DraftRow[];
  tenantSlug: string;
  accentClass: string;
  now: Date;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-medium">
          {title} <span className="text-ink/40">({drafts.length})</span>
        </h2>
        <p className="text-xs text-ink/60">{subtitle}</p>
      </div>
      <ul className="space-y-2">
        {drafts.map((d) => {
          const preview = d.body.slice(0, 180).replace(/\s+/g, " ");
          const deadline = d.fcgWindowDeadline;
          const deadlineLabel = deadline
            ? formatDeadlineRelative(deadline, now)
            : null;
          return (
            <li key={d.id}>
              <Link
                href={`/${tenantSlug}/drafts/${d.id}`}
                className={`card block hover:bg-ink/[0.02] ${accentClass}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {d.subject ?? "(no subject)"}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
                      <span className="tag">{d.kind}</span>
                      <span className="tag">{d.channel}</span>
                      {d.holdingRequired && (
                        <span className="tag bg-amber-100">holding</span>
                      )}
                      {d.researchTaskRequired && (
                        <span className="tag bg-violet-100">research required</span>
                      )}
                      {d.noGoSubjectHit && (
                        <span className="tag bg-red-100">no-go subject</span>
                      )}
                      {deadlineLabel && (
                        <span
                          className={
                            deadline && deadline.getTime() < now.getTime()
                              ? "tag bg-red-100 text-red-900"
                              : "tag bg-amber-100 text-amber-900"
                          }
                        >
                          {deadlineLabel}
                          <span className="ml-1 text-ink/50">
                            ({deadline!.toISOString().slice(0, 16).replace("T", " ")})
                          </span>
                        </span>
                      )}
                      <span>{d.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                      {d._count.actions > 0 && (
                        <span>· {d._count.actions} actions</span>
                      )}
                    </div>
                    <div className="mt-2 truncate text-xs text-ink/60">{preview}</div>
                  </div>
                  <span className="tag shrink-0">{d.status}</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
