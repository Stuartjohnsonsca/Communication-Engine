import { superDb } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Per-PRD §9.2: individual adherence is shown to the FCT **monthly in
 * arrears** to satisfy ICO worker-monitoring proportionality. We derive
 * monthly aggregates from `CommunicationAdherence` rows (per-comm scores)
 * into the `AdherenceScore` table, which is what the FCT-facing dashboard
 * reads. The current calendar month is *never* aggregated — only fully
 * closed months are eligible.
 */

export type DimensionKey =
  | "responseTime"
  | "tone"
  | "mandatoryPhrase"
  | "prohibitedPhrase"
  | "escalation";

const DIMS: DimensionKey[] = [
  "responseTime",
  "tone",
  "mandatoryPhrase",
  "prohibitedPhrase",
  "escalation",
];

export function periodKey(d: Date): string {
  // YYYY-MM in UTC. Monthly periods don't depend on tenant TZ for v1.
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

export function lastClosedPeriods(n: number, now = new Date()): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) {
    cur.setUTCMonth(cur.getUTCMonth() - 1);
    out.push(periodKey(cur));
  }
  return out;
}

function periodBounds(period: string): { start: Date; endExclusive: Date } {
  const [yStr, mStr] = period.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const endExclusive = new Date(Date.UTC(y, m, 1));
  return { start, endExclusive };
}

type PerDim = Record<DimensionKey, { score?: number | null; verdict?: string }>;

/**
 * Recompute AdherenceScore rows for the given closed periods for every
 * member of the tenant who has at least one CommunicationAdherence row in
 * that period. Idempotent. Existing rows for the period are overwritten so
 * late-arriving scores update the aggregate.
 */
export async function aggregateClosedMonths(
  tenantId: string,
  periods: string[],
): Promise<{ wrote: number; skipped: number }> {
  if (periods.length === 0) return { wrote: 0, skipped: 0 };
  const today = periodKey(new Date());
  const closed = periods.filter((p) => p < today); // current month is never closed

  let wrote = 0;
  let skipped = 0;

  for (const period of closed) {
    const { start, endExclusive } = periodBounds(period);
    const rows = await superDb.communicationAdherence.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lt: endExclusive },
      },
      select: { membershipId: true, overall: true, perDimension: true },
    });

    const byMember = new Map<
      string,
      {
        sum: number;
        n: number;
        dimSum: Record<DimensionKey, number>;
        dimN: Record<DimensionKey, number>;
        dimFails: Record<DimensionKey, number>;
      }
    >();

    for (const r of rows) {
      const acc =
        byMember.get(r.membershipId) ??
        {
          sum: 0,
          n: 0,
          dimSum: { responseTime: 0, tone: 0, mandatoryPhrase: 0, prohibitedPhrase: 0, escalation: 0 },
          dimN: { responseTime: 0, tone: 0, mandatoryPhrase: 0, prohibitedPhrase: 0, escalation: 0 },
          dimFails: { responseTime: 0, tone: 0, mandatoryPhrase: 0, prohibitedPhrase: 0, escalation: 0 },
        };
      acc.sum += r.overall;
      acc.n += 1;

      const dim = r.perDimension as PerDim;
      for (const k of DIMS) {
        const v = dim?.[k];
        if (v && typeof v.score === "number") {
          acc.dimSum[k] += v.score;
          acc.dimN[k] += 1;
        }
        if (v?.verdict === "fail") acc.dimFails[k] += 1;
      }
      byMember.set(r.membershipId, acc);
    }

    if (byMember.size === 0) {
      skipped += 1;
      continue;
    }

    for (const [membershipId, acc] of byMember) {
      const overall = acc.sum / acc.n;
      const perDimension: Record<
        DimensionKey,
        { score: number | null; n: number; fails: number }
      > = {
        responseTime: { score: null, n: 0, fails: 0 },
        tone: { score: null, n: 0, fails: 0 },
        mandatoryPhrase: { score: null, n: 0, fails: 0 },
        prohibitedPhrase: { score: null, n: 0, fails: 0 },
        escalation: { score: null, n: 0, fails: 0 },
      };
      for (const k of DIMS) {
        perDimension[k] = {
          score: acc.dimN[k] > 0 ? acc.dimSum[k] / acc.dimN[k] : null,
          n: acc.dimN[k],
          fails: acc.dimFails[k],
        };
      }

      const payload: Prisma.InputJsonValue = {
        perDimension,
      } as Prisma.InputJsonValue;

      await superDb.adherenceScore.upsert({
        where: { membershipId_period: { membershipId, period } },
        update: { overall, sampleN: acc.n, payload },
        create: {
          tenantId,
          membershipId,
          period,
          overall,
          sampleN: acc.n,
          payload,
        },
      });
      wrote += 1;
    }
  }

  return { wrote, skipped };
}
