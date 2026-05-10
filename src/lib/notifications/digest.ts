import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { aggregateForMembership, digestHasContent, type MembershipDigest } from "./aggregate";
import { dispatchNotification } from "./dispatch";

/**
 * Weekly digest dispatch. Walks every active membership, aggregates their
 * outstanding inbox, and emails one summary per membership keyed by ISO
 * week so a flaky cron / retry never sends twice.
 *
 * Only emails when the digest has content — an empty digest produces no
 * email and no inbox row. The cron logs the totals either way so the
 * scheduler tail shows what was reached.
 */

export type DigestRunResult = {
  weekKey: string;
  membershipsScanned: number;
  membershipsWithContent: number;
  dispatched: number;
  alreadySent: number;
  skipped: number;
  failed: number;
};

export async function runWeeklyDigest(opts?: {
  /** Override "now" for tests. */
  now?: Date;
  /** Override the dedupe week key (tests use this to assert idempotency). */
  weekKey?: string;
  /** Restrict to a single tenant — tests + on-demand triggers. */
  tenantId?: string;
}): Promise<DigestRunResult> {
  const now = opts?.now ?? new Date();
  const weekKey = opts?.weekKey ?? isoWeekKey(now);

  const memberships = await superDb.membership.findMany({
    where: {
      status: "ACTIVE",
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      tenant: {
        status: { in: ["ACTIVE", "PROVISIONING"] },
      },
    },
    include: {
      tenant: true,
      user: true,
    },
  });

  let membershipsWithContent = 0;
  let dispatched = 0;
  let alreadySent = 0;
  let skipped = 0;
  let failed = 0;

  for (const m of memberships) {
    if (!m.user.email) {
      skipped += 1;
      continue;
    }
    let digest: MembershipDigest;
    try {
      digest = await aggregateForMembership({ tenant: m.tenant, membership: m });
    } catch {
      failed += 1;
      continue;
    }
    if (!digestHasContent(digest)) {
      skipped += 1;
      continue;
    }
    membershipsWithContent += 1;
    const subject = renderSubject(digest);
    const text = renderText(digest);
    const summary = renderSummary(digest);

    const result = await dispatchNotification({
      tenantId: m.tenantId,
      membershipId: m.id,
      toEmail: m.user.email,
      kind: "weekly_digest",
      dedupeKey: weekKey,
      subject,
      summary,
      text,
      href: `/${m.tenant.slug}/notifications`,
      payload: {
        weekKey,
        totalOpen: digest.totalOpen,
        fcgProposals: digest.fcgProposals,
        actions: digest.actions,
        sentimentEscalations: digest.sentimentEscalations,
        adherenceEscalations: digest.adherenceEscalations,
        breachAcks: digest.breachAcks,
        expiries: digest.expiries,
      },
    });
    if (result.alreadySent) alreadySent += 1;
    else if (result.status === "DISPATCHED" || result.status === "SKIPPED_NO_EMAIL_SERVER") {
      dispatched += 1;
    } else if (result.status === "FAILED") {
      failed += 1;
    }
  }

  // Per-run audit on the operator's tenant chain — same pattern as billing /
  // lifecycle sweep. We attribute to the Acumon tenant if present so the
  // operator's chain shows the run; if the run was scoped to a single tenant
  // we attribute to that tenant.
  const auditTenantId = opts?.tenantId ?? (await acumonTenantId());
  if (auditTenantId) {
    await writeAuditEvent({
      tenantId: auditTenantId,
      eventType: "NOTIFICATION_DIGEST_RUN",
      actorMembershipId: null,
      subjectType: "NotificationDispatch",
      subjectId: weekKey,
      payload: {
        weekKey,
        membershipsScanned: memberships.length,
        membershipsWithContent,
        dispatched,
        alreadySent,
        skipped,
        failed,
      },
    });
  }

  return {
    weekKey,
    membershipsScanned: memberships.length,
    membershipsWithContent,
    dispatched,
    alreadySent,
    skipped,
    failed,
  };
}

async function acumonTenantId(): Promise<string | null> {
  const t = await superDb.tenant.findUnique({
    where: { slug: "acumon" },
    select: { id: true },
  });
  return t?.id ?? null;
}

/**
 * ISO-8601 week key like "2026-W19". Stable across timezones because we
 * compute against UTC — the "Monday morning" cadence is approximate
 * (Railway cron fires UTC), and the dedupe key only needs to be the same
 * value across retries within the same week.
 */
export function isoWeekKey(date: Date): string {
  // Algorithm per https://en.wikipedia.org/wiki/ISO_week_date
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function renderSubject(d: MembershipDigest): string {
  const total = d.totalOpen;
  if (total === 0) return `Acumon Communications · weekly digest`;
  return `Acumon Communications · ${total} item${total === 1 ? "" : "s"} for this week`;
}

function renderSummary(d: MembershipDigest): string {
  const parts: string[] = [];
  if (d.fcgProposals.open) {
    parts.push(`${d.fcgProposals.open} proposal${d.fcgProposals.open === 1 ? "" : "s"} to vote on`);
  }
  if (d.actions.overdue) {
    parts.push(`${d.actions.overdue} overdue action${d.actions.overdue === 1 ? "" : "s"}`);
  }
  if (d.sentimentEscalations.mine) {
    parts.push(`${d.sentimentEscalations.mine} sentiment escalation${d.sentimentEscalations.mine === 1 ? "" : "s"}`);
  }
  if (d.adherenceEscalations.mine) {
    parts.push(`${d.adherenceEscalations.mine} adherence escalation${d.adherenceEscalations.mine === 1 ? "" : "s"}`);
  }
  if (d.breachAcks.pending) {
    parts.push(`${d.breachAcks.pending} breach ack pending`);
  }
  if (d.expiries.dpiaWithin30Days) parts.push(`DPIA expiry`);
  if (d.expiries.tiasExpiringSoon) parts.push(`${d.expiries.tiasExpiringSoon} TIA expiring`);
  if (d.expiries.termsExpiringSoon) parts.push(`${d.expiries.termsExpiringSoon} terms expiring`);
  return parts.join(" · ") || "Nothing outstanding";
}

function renderText(d: MembershipDigest): string {
  const lines: string[] = [];
  const slug = d.tenant.slug;
  lines.push(`Hi ${d.membership.user.name ?? d.membership.user.email},`);
  lines.push("");
  lines.push(`Here's what's outstanding for you in ${d.tenant.name} this week.`);
  lines.push("");

  if (d.fcgProposals.open) {
    lines.push(`▸ ${d.fcgProposals.open} Firm Culture Guide proposal${d.fcgProposals.open === 1 ? "" : "s"} open for vote.`);
    if (d.fcgProposals.closingSoon) {
      lines.push(`  ${d.fcgProposals.closingSoon} closing within 48 hours.`);
    }
    lines.push(`  /${slug}/fcg`);
    lines.push("");
  }

  if (d.actions.open) {
    lines.push(`▸ ${d.actions.open} open action${d.actions.open === 1 ? "" : "s"} assigned to you.`);
    if (d.actions.overdue) {
      lines.push(`  ${d.actions.overdue} OVERDUE.`);
    }
    lines.push(`  /${slug}/actions`);
    lines.push("");
  }

  if (d.sentimentEscalations.mine || d.sentimentEscalations.firmWideOpen) {
    lines.push(`▸ Sentiment escalations`);
    if (d.sentimentEscalations.mine) {
      lines.push(`  ${d.sentimentEscalations.mine} assigned to you.`);
    }
    if (d.sentimentEscalations.firmWideOpen) {
      lines.push(`  ${d.sentimentEscalations.firmWideOpen} open firm-wide.`);
    }
    lines.push(`  /${slug}/sentiment`);
    lines.push("");
  }

  if (d.adherenceEscalations.mine || d.adherenceEscalations.firmWideOpen) {
    lines.push(`▸ Adherence escalations`);
    if (d.adherenceEscalations.mine) {
      lines.push(`  ${d.adherenceEscalations.mine} on your sends.`);
    }
    if (d.adherenceEscalations.firmWideOpen) {
      lines.push(`  ${d.adherenceEscalations.firmWideOpen} open firm-wide.`);
    }
    lines.push(`  /${slug}/adherence/escalations`);
    lines.push("");
  }

  if (d.breachAcks.pending) {
    lines.push(`▸ ${d.breachAcks.pending} breach notification${d.breachAcks.pending === 1 ? "" : "s"} pending acknowledgement.`);
    lines.push(`  /${slug}/compliance/breaches`);
    lines.push("");
  }

  if (d.expiries.dpiaWithin30Days) {
    lines.push(
      d.expiries.dpiaDaysUntil != null && d.expiries.dpiaDaysUntil >= 0
        ? `▸ DPIA expires in ${d.expiries.dpiaDaysUntil} day${d.expiries.dpiaDaysUntil === 1 ? "" : "s"}.`
        : `▸ DPIA needs attention.`,
    );
    lines.push(`  /${slug}/dpia`);
    lines.push("");
  }
  if (d.expiries.tiasExpiringSoon) {
    lines.push(`▸ ${d.expiries.tiasExpiringSoon} Transfer Impact Assessment${d.expiries.tiasExpiringSoon === 1 ? "" : "s"} expiring within 30 days.`);
    lines.push(`  /${slug}/compliance/transfers`);
    lines.push("");
  }
  if (d.expiries.termsExpiringSoon) {
    lines.push(`▸ ${d.expiries.termsExpiringSoon} terms record${d.expiries.termsExpiringSoon === 1 ? "" : "s"} expiring within 30 days.`);
    lines.push(`  /${slug}/admin/terms`);
    lines.push("");
  }

  lines.push("");
  lines.push(`Open the in-app inbox: /${slug}/notifications`);

  return lines.join("\n");
}
