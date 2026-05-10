import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { getDpiaStatus } from "@/lib/dpia/status";
import { detectOpportunity } from "@/lib/opportunities/detect";
import { reportError } from "@/lib/observability";

type Filter = "OPEN" | "ACCEPTED" | "REJECTED" | "ROUTED" | "ALL";
const FILTERS: Filter[] = ["OPEN", "ACCEPTED", "REJECTED", "ROUTED", "ALL"];

const FILTER_LABEL: Record<Filter, string> = {
  OPEN: "Open",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  ROUTED: "Routed to Partner",
  ALL: "All",
};

const STATUS_BG: Record<string, string> = {
  NEW: "bg-sky-100 text-sky-800",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  ACCEPTED: "bg-emerald-100 text-emerald-800",
  REVISED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-700",
  ROUTED_TO_PARTNER: "bg-violet-100 text-violet-800",
};

const CLASS_LABEL: Record<string, string> = {
  new_engagement: "new engagement",
  expansion: "expansion",
  renewal: "renewal",
  cross_sell: "cross-sell",
  referral: "referral",
};

function parseFilter(v: string | undefined): Filter {
  if (v && (FILTERS as string[]).includes(v)) return v as Filter;
  return "OPEN";
}

const OPEN_STATUSES = ["NEW", "UNDER_REVIEW"] as const;
const DECIDED_STATUSES = ["ACCEPTED", "REVISED", "REJECTED", "ROUTED_TO_PARTNER"] as const;

export default async function OpportunitiesPage({
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

  const canReview = hasPermission(ctx.membership.role, "opportunity:review");
  const canAdmin = hasPermission(ctx.membership.role, "members:write");

  const [tenant, dpia] = await Promise.all([
    superDb.tenant.findUnique({
      where: { id: ctx.tenant.id },
      select: {
        salesIdentifierEnabled: true,
        salesIdentifierLawfulBasisAttestedAt: true,
      },
    }),
    getDpiaStatus(ctx.tenant.id),
  ]);
  if (!tenant) redirect(`/${tenantSlug}/dashboard`);

  const lawfulBasisOnFile = !!tenant.salesIdentifierLawfulBasisAttestedAt;
  const operational = tenant.salesIdentifierEnabled && lawfulBasisOnFile && dpia.salesIdentifierAllowed;

  const baseWhere = { tenantId: ctx.tenant.id };
  const filterWhere =
    filter === "ALL"
      ? {}
      : filter === "OPEN"
        ? { status: { in: [...OPEN_STATUSES] } }
        : filter === "ROUTED"
          ? { status: "ROUTED_TO_PARTNER" }
          : { status: filter };

  const [candidates, statusCounts] = await Promise.all([
    superDb.opportunityCandidate.findMany({
      where: { ...baseWhere, ...filterWhere },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: {
        sourceMessage: { select: { sender: true, subject: true } },
        reviewer: { include: { user: { select: { email: true, name: true } } } },
        decidedBy: { include: { user: { select: { email: true, name: true } } } },
        _count: { select: { comments: true } },
      },
    }),
    superDb.opportunityCandidate.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { _all: true },
    }),
  ]);

  const countByStatus: Record<string, number> = {};
  for (const c of statusCounts) countByStatus[c.status] = c._count._all;
  const totals: Record<Filter, number> = {
    OPEN: OPEN_STATUSES.reduce((a, s) => a + (countByStatus[s] ?? 0), 0),
    ACCEPTED: (countByStatus.ACCEPTED ?? 0) + (countByStatus.REVISED ?? 0),
    REJECTED: countByStatus.REJECTED ?? 0,
    ROUTED: countByStatus.ROUTED_TO_PARTNER ?? 0,
    ALL: DECIDED_STATUSES.reduce((a, s) => a + (countByStatus[s] ?? 0), 0)
      + OPEN_STATUSES.reduce((a, s) => a + (countByStatus[s] ?? 0), 0),
  };

  async function scanRecentAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "opportunity:review")) throw new Error("forbidden");

    // Pull the last 10 inbound external messages that don't already have a
    // candidate, run the detector once each, and revalidate.
    const recentInbound = await superDb.ingestedMessage.findMany({
      where: {
        tenantId: inner.tenant.id,
        direction: "IN",
        opportunities: { none: {} },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, channel: { select: { kind: true } }, sender: true, subject: true, body: true },
    });

    for (const msg of recentInbound) {
      try {
        await detectOpportunity({
          tenantId: inner.tenant.id,
          ingestedMessageId: msg.id,
          inbound: {
            channel: msg.channel?.kind ?? "EMAIL",
            sender: msg.sender,
            subject: msg.subject,
            body: msg.body,
          },
        });
      } catch (e) {
        reportError(e, {
          route: "[tenantSlug]/opportunities (server action)",
          tenantId: inner.tenant.id,
          tenantSlug,
          extra: { ingestedMessageId: msg.id },
        }, "detectOpportunity failed");
      }
    }

    revalidatePath(`/${tenantSlug}/opportunities`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sales Identifier</h1>
        <div className="flex gap-2 text-xs">
          {canAdmin && (
            <Link
              href={`/${tenantSlug}/admin/sales-identifier`}
              className="tag bg-ink/5 hover:bg-ink/10"
            >
              Admin & lawful-basis →
            </Link>
          )}
        </div>
      </div>
      <p className="text-xs text-ink/60">
        PRD §8 — opportunities detected from inbound communications. Sales Reviewers accept (and
        allocate), revise (and re-route), reject, or route to Partner. Comments and revisions feed
        (anonymised) into Cross-Client Learning if the firm has opted in.
      </p>

      <OperationalBanner
        tenantSlug={tenantSlug}
        siEnabled={tenant.salesIdentifierEnabled}
        lawfulBasisOnFile={lawfulBasisOnFile}
        dpiaAllowed={dpia.salesIdentifierAllowed}
        canAdmin={canAdmin}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 text-xs">
          {FILTERS.map((f) => {
            const active = f === filter;
            return (
              <Link
                key={f}
                href={`/${tenantSlug}/opportunities?filter=${f}`}
                className={`tag ${active ? "bg-ink text-white" : "bg-ink/5 hover:bg-ink/10"}`}
              >
                {FILTER_LABEL[f]}{" "}
                <span className="ml-1 tabular-nums opacity-70">{totals[f]}</span>
              </Link>
            );
          })}
        </div>
        {canReview && operational && (
          <form action={scanRecentAction} className="ml-auto">
            <button type="submit" className="btn text-xs">
              Scan recent inbound
            </button>
          </form>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="card text-sm text-ink/60">
          No candidates match this filter.
          {!operational && (
            <>
              {" "}
              The detector is gated — see the banner above for what is missing.
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((c) => {
            const conf = c.confidence == null ? null : Math.round(c.confidence * 100);
            const decided = !!c.decidedAt;
            return (
              <Link
                key={c.id}
                href={`/${tenantSlug}/opportunities/${c.id}`}
                className="card block space-y-2 hover:border-ink/30"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`tag ${STATUS_BG[c.status] ?? ""}`}>{c.status}</span>
                    {c.classification && (
                      <span className="tag bg-ink/5">
                        {CLASS_LABEL[c.classification] ?? c.classification}
                      </span>
                    )}
                    {c.jurisdiction && (
                      <span className="text-xs text-ink/60">{c.jurisdiction}</span>
                    )}
                    {c.serviceLine && (
                      <span className="text-xs text-ink/60">· {c.serviceLine}</span>
                    )}
                    {conf != null && (
                      <span className="text-xs text-ink/50 tabular-nums">{conf}% confidence</span>
                    )}
                  </div>
                  <div className="text-xs text-ink/50">
                    {c.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </div>
                </div>

                {c.sourceMessage && (
                  <div className="text-xs text-ink/60">
                    {c.sourceMessage.sender && <>from {c.sourceMessage.sender} · </>}
                    <span className="font-medium">
                      {c.sourceMessage.subject ?? "(no subject)"}
                    </span>
                  </div>
                )}

                {c.rationale && (
                  <p className="text-sm text-ink/80 line-clamp-2">{c.rationale}</p>
                )}

                <div className="flex flex-wrap gap-3 text-xs text-ink/60">
                  {c.suggestedReviewerTeam && (
                    <span>
                      suggested team:{" "}
                      <span className="font-medium">{c.suggestedReviewerTeam}</span>
                    </span>
                  )}
                  {c.reviewer && (
                    <span>
                      assigned to{" "}
                      <span className="font-medium">
                        {c.reviewer.user.name ?? c.reviewer.user.email}
                      </span>
                    </span>
                  )}
                  {decided && c.decidedBy && (
                    <span>
                      decided by {c.decidedBy.user.name ?? c.decidedBy.user.email}
                    </span>
                  )}
                  {c._count.comments > 0 && (
                    <span>
                      {c._count.comments} comment{c._count.comments === 1 ? "" : "s"}
                    </span>
                  )}
                  {c.partnerType !== "DEFAULT" && c.status === "ROUTED_TO_PARTNER" && (
                    <span className="tag bg-violet-100 text-violet-800">{c.partnerType}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OperationalBanner({
  tenantSlug,
  siEnabled,
  lawfulBasisOnFile,
  dpiaAllowed,
  canAdmin,
}: {
  tenantSlug: string;
  siEnabled: boolean;
  lawfulBasisOnFile: boolean;
  dpiaAllowed: boolean;
  canAdmin: boolean;
}) {
  if (siEnabled && lawfulBasisOnFile && dpiaAllowed) return null;

  const missing: string[] = [];
  if (!siEnabled) missing.push("the add-on is disabled");
  if (!lawfulBasisOnFile) missing.push("the §8.5 lawful-basis acknowledgement is missing");
  if (!dpiaAllowed) missing.push("the DPIA gate is failing");

  return (
    <div className="rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
      Sales Identifier detector is paused — {missing.join("; ")}. Existing candidates remain
      reviewable.{" "}
      {canAdmin ? (
        <Link
          href={`/${tenantSlug}/admin/sales-identifier`}
          className="underline decoration-dotted"
        >
          Open admin →
        </Link>
      ) : (
        <span>Ask a Firm Administrator to address this.</span>
      )}
    </div>
  );
}
