import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { ADHERENCE_ESCALATION_THRESHOLD } from "@/lib/adherence/escalation";
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

  const [rows, openCount, ackCount, allCount] = await Promise.all([
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
  ]);

  const totals: Record<Filter, number> = { OPEN: openCount, ACKNOWLEDGED: ackCount, ALL: allCount };
  const thresholdPct = Math.round(ADHERENCE_ESCALATION_THRESHOLD * 100);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Adherence escalations</h1>
        <span className="text-xs text-ink/50">
          {firmWide ? "firm-wide view" : "your sends only"}
        </span>
      </div>
      <p className="text-xs text-ink/60">
        PRD §9.1 + post-PRD compliance gate. Every observed outbound communication is scored against the
        FCG / UCG used at the time. Sends scoring below {thresholdPct}% overall escalate to the User and
        the FCT — whether the send went through the drafting UI or bypassed it via the connected mailbox.
      </p>

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
