import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { judgeUcg } from "@/lib/ai/agents/judgeAgent";
import { addWorkingDays } from "@/lib/working-days";

/**
 * PRD §5.2.2 — when an FCG amendment is committed, every currently committed
 * UserCultureGuide in the tenant is automatically flagged with a 10-working-
 * day grace period. The conflict resolves (status returns to COMMITTED, fields
 * cleared) when the user commits a new UCG version that judges clean against
 * the new FCG. Otherwise the sweep auto-suspends the conflicting rules.
 *
 * This function is intentionally fail-soft: it never throws into the
 * caller (the FCG commit transaction has already succeeded). Failures here
 * are logged and surfaced via the audit log so an operator can replay.
 */
export async function flagConflictsAfterFcgCommit(opts: {
  tenantId: string;
  newFcgId: string;
  actorMembershipId?: string | null;
  graceDays?: number;
  now?: Date;
}): Promise<{ flagged: number; judged: number; cleared: number }> {
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? 10;
  const gracePeriodEndsAt = addWorkingDays(now, graceDays);

  const newFcg = await superDb.firmCultureGuide.findUnique({
    where: { id: opts.newFcgId },
    include: { rules: true },
  });
  if (!newFcg) return { flagged: 0, judged: 0, cleared: 0 };

  // Every currently-active UCG in the tenant is a candidate. A UCG already
  // based on the new FCG (e.g. the user committed the new UCG before the
  // FCG vote closed) is excluded.
  const candidates = await superDb.userCultureGuide.findMany({
    where: {
      tenantId: opts.tenantId,
      status: { in: ["COMMITTED", "CONFLICTED"] },
      basedOnFcgId: { not: opts.newFcgId },
    },
    include: { rules: true, membership: true },
  });
  if (candidates.length === 0) return { flagged: 0, judged: 0, cleared: 0 };

  // Step 1 — synchronously flag every candidate. The grace period clock
  // starts now whether or not the judge has run yet, so users always have
  // the full 10 working days regardless of judge latency.
  await superDb.userCultureGuide.updateMany({
    where: { id: { in: candidates.map((u) => u.id) } },
    data: {
      status: "CONFLICTED",
      conflictedSinceFcgId: opts.newFcgId,
      conflictFlaggedAt: now,
      gracePeriodEndsAt,
      conflictAutoSuspendedAt: null,
    },
  });

  for (const ucg of candidates) {
    await writeAuditEvent({
      tenantId: opts.tenantId,
      eventType: "UCG_CONFLICT_FLAGGED",
      actorMembershipId: opts.actorMembershipId ?? null,
      subjectType: "UserCultureGuide",
      subjectId: ucg.id,
      payload: {
        newFcgId: opts.newFcgId,
        newFcgVersion: newFcg.version,
        gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
        graceDays,
      },
    });
  }

  // Step 2 — fire-and-forget the actual judge calls so the FCG commit
  // request returns promptly. Each call is independent; one failure
  // doesn't block the rest.
  let judged = 0;
  let cleared = 0;
  const fcgJson = {
    version: newFcg.version,
    rules: newFcg.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      mandatory: r.mandatory,
    })),
  };

  for (const ucg of candidates) {
    try {
      const ucgJson = {
        version: ucg.version,
        rules: ucg.rules
          .filter((r) => !r.suspendedAt)
          .map((r) => ({
            externalId: r.externalId,
            category: r.category,
            channel: r.channel,
            statement: r.statement,
            payload: r.payload,
            narrowsFcgRule: r.narrowsFcgRule,
          })),
      };
      const judgement = await judgeUcg({
        fcg: fcgJson,
        ucg: ucgJson,
        tenantId: opts.tenantId,
      });
      judged++;

      await superDb.complianceRuling.deleteMany({ where: { ucgId: ucg.id } });
      if (judgement.rulings.length > 0) {
        await superDb.complianceRuling.createMany({
          data: judgement.rulings.map((r) => ({
            tenantId: opts.tenantId,
            ucgId: ucg.id,
            ucgRuleId: r.ucgRuleId,
            fcgRuleId: r.fcgClauseCited ?? null,
            verdict:
              r.verdict === "pass" ? "PASS" : r.verdict === "fail" ? "FAIL" : "NOT_APPLICABLE",
            severity: r.severity,
            explanation: r.explanation,
            suggestedFix: r.suggestedFix,
            judgeModel: "claude-sonnet-4-6",
          })) as Prisma.ComplianceRulingCreateManyInput[],
        });
      }

      const blocking = judgement.rulings.filter(
        (r) => r.verdict === "fail" && r.severity === "blocking",
      );
      if (judgement.overall === "pass" || blocking.length === 0) {
        // No conflict against the new FCG — clear the flag immediately.
        await superDb.userCultureGuide.update({
          where: { id: ucg.id },
          data: {
            status: "COMMITTED",
            judgeStatus: judgement.overall,
            conflictedSinceFcgId: null,
            conflictFlaggedAt: null,
            gracePeriodEndsAt: null,
            conflictAutoSuspendedAt: null,
          },
        });
        cleared++;
      } else {
        // Real conflict — keep flagged, persist judge status for the UI.
        await superDb.userCultureGuide.update({
          where: { id: ucg.id },
          data: { judgeStatus: judgement.overall },
        });
      }
    } catch (e) {
      console.error(`[flagConflictsAfterFcgCommit] judge failed for UCG ${ucg.id}:`, e);
      // Leave the UCG flagged; sweep will handle it at grace expiry.
    }
  }

  return { flagged: candidates.length, judged, cleared };
}

/**
 * PRD §5.2.2 — sweep all UCGs whose grace period has elapsed and auto-suspend
 * the rules that the most recent compliance ruling marked as blocking-FAIL.
 *
 * Idempotent: re-running the sweep will not double-suspend rules. Returns a
 * per-tenant summary suitable for an audit log entry by the caller.
 */
export async function sweepConflictedUcgs(opts: {
  tenantId: string;
  now?: Date;
}): Promise<{ ucgsSwept: number; rulesSuspended: number }> {
  const now = opts.now ?? new Date();

  const due = await superDb.userCultureGuide.findMany({
    where: {
      tenantId: opts.tenantId,
      status: "CONFLICTED",
      gracePeriodEndsAt: { lte: now, not: null },
      conflictAutoSuspendedAt: null,
    },
    include: { rules: true, rulings: true },
  });

  let rulesSuspendedTotal = 0;
  for (const ucg of due) {
    // Identify rules to suspend: every UCGRule that has a blocking-FAIL
    // ruling against it. Rules without rulings (e.g. judge call failed)
    // are conservatively NOT suspended — the sweep can be re-run after
    // an operator triggers the judge.
    const blockingByRule = new Set(
      ucg.rulings
        .filter((r) => r.verdict === "FAIL" && r.severity === "blocking" && r.ucgRuleId)
        .map((r) => r.ucgRuleId as string),
    );
    const toSuspend = ucg.rules.filter(
      (r) => blockingByRule.has(r.id) && !r.suspendedAt,
    );

    if (toSuspend.length > 0) {
      await superDb.uCGRule.updateMany({
        where: { id: { in: toSuspend.map((r) => r.id) } },
        data: {
          suspendedAt: now,
          suspendReason: `fcg_conflict:${ucg.conflictedSinceFcgId ?? "unknown"}`,
        },
      });
      for (const r of toSuspend) {
        await writeAuditEvent({
          tenantId: opts.tenantId,
          eventType: "UCG_RULE_AUTO_SUSPENDED",
          subjectType: "UCGRule",
          subjectId: r.id,
          payload: {
            ucgId: ucg.id,
            ruleExternalId: r.externalId,
            conflictedSinceFcgId: ucg.conflictedSinceFcgId,
          },
        });
      }
      rulesSuspendedTotal += toSuspend.length;
    }

    await superDb.userCultureGuide.update({
      where: { id: ucg.id },
      data: { conflictAutoSuspendedAt: now },
    });
  }

  return { ucgsSwept: due.length, rulesSuspended: rulesSuspendedTotal };
}
