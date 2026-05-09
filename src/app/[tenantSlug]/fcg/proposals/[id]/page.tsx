import { redirect } from "next/navigation";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { eligibleVoterIds } from "@/lib/voting/quorum";
import { hasPermission } from "@/lib/rbac";
import VoteButtons from "./VoteButtons";
import OpenForVoteButton from "./OpenForVoteButton";

export default async function ProposalPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
}) {
  const { tenantSlug, id } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const proposal = await superDb.fCGProposal.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    include: { votes: { include: { voter: { include: { user: true } } } } },
  });
  if (!proposal) {
    return <p className="text-sm text-ink/60">Proposal not found.</p>;
  }
  const eligible = await eligibleVoterIds(ctx.tenant.id);
  const isEligible = eligible.includes(ctx.membership.id);
  const myVote = proposal.votes.find((v) => v.membershipId === ctx.membership.id);
  const ops = (proposal.diff as { ops?: { tool: string; input: Record<string, unknown> }[] })?.ops ?? [];

  // PRD §5.2.2 — preview the propagation impact. Every active UCG (not
  // already pegged to a future FCG) will be flagged with a 10-working-day
  // grace period if this proposal passes. The judge re-runs against each;
  // some clear immediately and the rest enter the grace window. We don't
  // try to predict which clear here — that would mean running the full
  // judge against every UCG on every page load.
  const impactedUcgCount =
    proposal.state === "DRAFTING" || proposal.state === "OPEN_FOR_VOTE"
      ? await superDb.userCultureGuide.count({
          where: { tenantId: ctx.tenant.id, status: { in: ["COMMITTED", "CONFLICTED"] } },
        })
      : 0;

  return (
    <div className="space-y-4">
      <Link href={`/${tenantSlug}/fcg`} className="text-sm">
        ← All proposals
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{proposal.title}</h1>
      <div className="flex items-center gap-3 text-sm">
        <span className="tag">{proposal.state}</span>
        {proposal.isEmergency && <span className="tag bg-amber-100">emergency</span>}
        <span className="text-ink/60">
          {proposal.votes.length}/{eligible.length} voted
          {proposal.votingClosesAt && ` · closes ${proposal.votingClosesAt.toISOString()}`}
        </span>
      </div>

      <div className="card">
        <h2 className="text-base font-medium">Staged operations ({ops.length})</h2>
        <ol className="mt-3 space-y-2 text-sm">
          {ops.length === 0 && <li className="text-ink/50">none</li>}
          {ops.map((op, i) => {
            const r = op.input.rule as Record<string, unknown> | undefined;
            return (
              <li key={i} className="rounded border border-ink/10 p-3">
                <div className="font-mono text-xs text-ink/60">
                  {op.tool} · {String(op.input.action ?? "")}
                </div>
                {r && (
                  <>
                    <div className="mt-1 text-xs">
                      <span className="font-mono">{String(r.externalId)}</span>{" "}
                      <span className="tag">{String(r.category)}</span>{" "}
                      <span className="tag">{String(r.channel ?? "any")}</span>
                    </div>
                    <p className="mt-1">{String(r.statement)}</p>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {(proposal.state === "DRAFTING" || proposal.state === "OPEN_FOR_VOTE") && (
        <div className="card border-amber-200 bg-amber-50/40">
          <h2 className="text-base font-medium">If this passes</h2>
          <p className="mt-1 text-xs text-ink/70">
            {impactedUcgCount === 0 ? (
              <>No User Culture Guides exist yet — nothing to propagate.</>
            ) : (
              <>
                <strong>{impactedUcgCount}</strong> active User Culture Guide
                {impactedUcgCount === 1 ? " will be" : "s will be"} re-judged against the
                amended FCG. Any that don&rsquo;t pass enter a 10 working-day grace period
                (PRD §5.2.2); after that, conflicting rules auto-suspend until the user
                recommits a clean version.
              </>
            )}
          </p>
        </div>
      )}

      <div className="card">
        <h2 className="text-base font-medium">Votes</h2>
        <ul className="mt-3 divide-y divide-ink/5 text-sm">
          {proposal.votes.map((v) => (
            <li key={v.id} className="flex items-center justify-between py-2">
              <span>{v.voter.user.email}</span>
              <span className="tag">{v.decision}</span>
            </li>
          ))}
          {proposal.votes.length === 0 && <li className="py-2 text-ink/50">No votes yet.</li>}
        </ul>
      </div>

      {proposal.state === "DRAFTING" && hasPermission(ctx.membership.role, "fcg:propose") && (
        <div className="card">
          <h2 className="text-base font-medium">Open for vote</h2>
          <p className="mt-1 text-xs text-ink/60">
            This proposal is still a draft. Open it to start the Firm Culture Team vote.
            {ops.length === 0 && " Note: nothing is staged yet — you may want to add rules in chat first."}
          </p>
          <OpenForVoteButton tenantSlug={tenantSlug} proposalId={proposal.id} />
        </div>
      )}

      {proposal.state === "OPEN_FOR_VOTE" && isEligible && (
        <div className="card">
          <h2 className="text-base font-medium">Cast your vote</h2>
          <p className="mt-1 text-xs text-ink/60">
            Your last vote: <span className="tag">{myVote?.decision ?? "none"}</span>
          </p>
          <VoteButtons tenantSlug={tenantSlug} proposalId={proposal.id} />
        </div>
      )}
    </div>
  );
}
