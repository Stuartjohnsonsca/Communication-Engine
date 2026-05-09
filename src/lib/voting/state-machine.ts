import type { FCGProposal, FCGVote, ProposalState } from "@prisma/client";

export type VotingTally = {
  approve: number;
  reject: number;
  abstain: number;
  totalEligible: number;
  quorumPct: number;
};

export type VotingDecision =
  | { state: "OPEN_FOR_VOTE"; reason: string }
  | { state: "PASSED"; reason: string }
  | { state: "FAILED"; reason: string }
  | { state: "EXPIRED"; reason: string };

/**
 * Voting state machine per PRD §6.1.
 *
 *   DRAFTING ──open()──▶ OPEN_FOR_VOTE
 *                          │
 *                          ├──quorumReached & majorityApprove──▶ PASSED
 *                          ├──quorumReached & tie or majorityReject──▶ FAILED
 *                          └──windowElapsed & !quorum────────────▶ EXPIRED
 *
 * Quorum: a number of *eligible* voters >= quorumPct% of total membership
 * (default 50%; configurable up to two-thirds).
 *
 * Tie at quorum close = FAILED, with a 24h cooldown enforced by the route
 * layer at re-submission time (see route handler).
 *
 * Emergency proposals collapse the window to 24h; everything else identical.
 */
export function evaluate(
  proposal: Pick<FCGProposal, "state" | "votingClosesAt" | "isEmergency">,
  votes: Pick<FCGVote, "decision">[],
  totalEligibleMembers: number,
  quorumPct: number,
  now: Date = new Date(),
): VotingDecision {
  if (proposal.state !== "OPEN_FOR_VOTE") {
    return { state: proposal.state as VotingDecision["state"], reason: "not open for vote" };
  }

  const tally = countVotes(votes, totalEligibleMembers, quorumPct);
  const cast = tally.approve + tally.reject + tally.abstain;
  const required = Math.ceil((totalEligibleMembers * quorumPct) / 100);
  const quorumReached = cast >= required;
  const windowClosed = !!proposal.votingClosesAt && now >= proposal.votingClosesAt;

  // Decisive resolution: even before window close, a clear majority of the
  // total membership (not just of those voting) decides the outcome.
  if (tally.approve > totalEligibleMembers / 2) {
    return { state: "PASSED", reason: `${tally.approve}/${totalEligibleMembers} approved` };
  }
  if (tally.reject > totalEligibleMembers / 2) {
    return { state: "FAILED", reason: `${tally.reject}/${totalEligibleMembers} rejected` };
  }

  if (!windowClosed) {
    return { state: "OPEN_FOR_VOTE", reason: "window still open" };
  }

  if (!quorumReached) {
    return { state: "EXPIRED", reason: `cast=${cast} < required=${required}` };
  }

  // Quorum reached but not a majority either way at window close.
  if (tally.approve > tally.reject) {
    return { state: "PASSED", reason: `quorum met, approve>${tally.reject}` };
  }
  // Tie or reject-majority at quorum close → FAILED.
  return { state: "FAILED", reason: tally.approve === tally.reject ? "tie at quorum close" : "rejected" };
}

export function countVotes(
  votes: Pick<FCGVote, "decision">[],
  totalEligible: number,
  quorumPct: number,
): VotingTally {
  let approve = 0,
    reject = 0,
    abstain = 0;
  for (const v of votes) {
    if (v.decision === "APPROVE") approve++;
    else if (v.decision === "REJECT") reject++;
    else abstain++;
  }
  return { approve, reject, abstain, totalEligible, quorumPct };
}

/** Window length per PRD §6.1: emergency = 24h, otherwise tenant default. */
export function votingWindowMs(isEmergency: boolean, defaultDays: number): number {
  if (isEmergency) return 24 * 60 * 60 * 1000;
  return defaultDays * 24 * 60 * 60 * 1000;
}
