import { superDb } from "@/lib/db";

/**
 * Snapshot the eligible Firm Culture Team voters for a tenant at a moment in
 * time. Per PRD §6.1, this list is frozen when a proposal transitions to
 * OPEN_FOR_VOTE so member departures during the vote do not move the goal-
 * posts mid-flight.
 */
export async function eligibleVoterIds(tenantId: string): Promise<string[]> {
  const members = await superDb.membership.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      role: { in: ["FCT_MEMBER", "FIRM_ADMIN"] },
    },
    select: { id: true },
  });
  return members.map((m) => m.id);
}
