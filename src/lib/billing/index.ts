import { Prisma, type Membership, type Role, type Tenant } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Billing module (PRD §15.1 Pricing Structure + §15.2 Inactive and
 * Edge-Case Users).
 *
 * The PRD defines a User as "active" in a billing month if they have
 * authorised at least one channel AND (logged in within the month OR had at
 * least one draft produced in the month). Suspended Users are not billed.
 *
 * One BillingPeriod row exists per tenant per calendar month. While the
 * period is `DRAFT` the totals can be recomputed live; on close they are
 * frozen alongside a snapshot of the pricing plan and a per-User snapshot
 * row that explains why each User was (or wasn't) billed. Re-opening a
 * closed period requires an explicit, audited admin action.
 */

export type Plan = {
  currency: string;
  baseMinor: number;
  salesIdMinor: number;
  salesIdEnabled: boolean;
  salesIdPartnerDefault: boolean;
  salesIdPartnerDiscountPct: number;
  crossClientLearningOptIn: boolean;
  cclDiscountPct: number;
  cmkEnabled: boolean;
  cmkMinor: number;
  isSandbox: boolean;
  sandboxBillingFreeUntil: Date | null;
};

export function planFromTenant(t: Tenant): Plan {
  return {
    currency: t.pricingCurrency,
    baseMinor: t.pricingBaseMinor,
    salesIdMinor: t.pricingSalesIdMinor,
    salesIdEnabled: t.salesIdentifierEnabled,
    salesIdPartnerDefault: t.pricingSalesIdPartnerDefault,
    salesIdPartnerDiscountPct: clampPct(t.pricingSalesIdPartnerDiscountPct),
    crossClientLearningOptIn: t.pricingCrossClientLearningOptIn,
    cclDiscountPct: clampPct(t.pricingCclDiscountPct),
    cmkEnabled: t.pricingCmkEnabled,
    cmkMinor: t.pricingCmkMinor,
    isSandbox: t.isSandbox,
    sandboxBillingFreeUntil: t.sandboxBillingFreeUntil,
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

/** Effective per-User SI rate after stacking the partner-default and CCL discounts. */
export function effectiveSalesIdMinor(plan: Plan): number {
  if (!plan.salesIdEnabled) return 0;
  let minor = plan.salesIdMinor;
  if (plan.salesIdPartnerDefault) {
    minor = Math.round(minor * (1 - plan.salesIdPartnerDiscountPct / 100));
  }
  if (plan.crossClientLearningOptIn) {
    minor = Math.round(minor * (1 - plan.cclDiscountPct / 100));
  }
  return Math.max(0, minor);
}

export type Money = { minor: number; currency: string; display: string };

export function formatMoney(minor: number, currency = "GBP"): Money {
  const major = (minor / 100).toFixed(2);
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  const display = symbol ? `${symbol}${major}` : `${major} ${currency}`;
  return { minor, currency, display };
}

// ─── Period boundaries ─────────────────────────────────────────────────────

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function parsePeriod(period: string): { year: number; month: number } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`billing: invalid period "${period}", expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`billing: invalid month in "${period}"`);
  return { year, month };
}

export function periodBounds(period: string): { start: Date; end: Date } {
  const { year, month } = parsePeriod(period);
  // Use UTC so DST shifts don't widen/narrow a month at the edges.
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

export function periodForDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function previousPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return periodForDate(d);
}

// ─── §15.2 activity evaluation ─────────────────────────────────────────────

export type UserActivity = {
  membership: Membership & { user: { email: string; name: string | null } };
  hasAuthorisedChannel: boolean;
  loggedInThisPeriod: boolean;
  hadDraftThisPeriod: boolean;
  draftCount: number;
  isActiveByPRD: boolean;
  isBillable: boolean;
  salesIdentifierApplies: boolean;
  reason: string;
};

type EvaluateInput = {
  tenant: Tenant;
  start: Date;
  end: Date;
  /**
   * For DRAFT/current-month estimates we treat "now" as the upper bound
   * for "logged in within the month" so an in-progress month doesn't
   * suppress activity from earlier in the same month.
   */
  evalAsOf: Date;
};

async function evaluateActivity(input: EvaluateInput): Promise<UserActivity[]> {
  const { tenant, start, end, evalAsOf } = input;
  const memberships = await superDb.membership.findMany({
    where: { tenantId: tenant.id },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { joinedAt: "asc" },
  });

  // Channel authorisations: a user "has authorised at least one channel"
  // for the period if they had a non-revoked auth at any point during the
  // period. A revocation that landed inside the period still counts as
  // "had access during the period" for billing — they consumed service.
  const channelAuths = await superDb.channelAuth.findMany({
    where: {
      tenantId: tenant.id,
      createdAt: { lt: end },
      OR: [{ revokedAt: null }, { revokedAt: { gt: start } }],
    },
    select: { membershipId: true },
  });
  const hasChannelByMembership = new Set(
    channelAuths.map((c) => c.membershipId).filter((id): id is string => !!id),
  );

  // Drafts produced in the period (any status — the PRD says "had at least
  // one draft produced", not "sent").
  const draftRows = await superDb.draft.groupBy({
    by: ["membershipId"],
    where: {
      tenantId: tenant.id,
      createdAt: { gte: start, lt: end },
    },
    _count: { _all: true },
  });
  const draftsByMembership = new Map<string, number>(
    draftRows.map((d) => [d.membershipId, d._count._all]),
  );

  return memberships.map((m) => {
    const hasChannel = hasChannelByMembership.has(m.id);
    const loggedIn =
      !!m.lastLoginAt &&
      m.lastLoginAt.getTime() >= start.getTime() &&
      m.lastLoginAt.getTime() <= Math.min(end.getTime() - 1, evalAsOf.getTime());
    const draftCount = draftsByMembership.get(m.id) ?? 0;
    const hadDraft = draftCount > 0;
    const isActive = hasChannel && (loggedIn || hadDraft);

    let billable = isActive;
    let reason = "";
    if (m.status === "SUSPENDED") {
      billable = false;
      reason = "suspended at evaluation";
    } else if (m.status === "ANONYMISED") {
      billable = false;
      reason = "anonymised";
    } else if (m.status === "LEAVER_FROZEN") {
      billable = false;
      reason = "leaver-frozen";
    } else if (m.status === "INVITED") {
      billable = false;
      reason = "invited only — never activated";
    } else if (m.accessRevokedAt && m.accessRevokedAt.getTime() <= end.getTime()) {
      // Revocation grace started before/during the period. The PRD treats
      // grace-window users as not billed (drafting is halted, channel
      // authorisations are revoked). They may still have been active
      // earlier in the month — that's reflected in `isActiveByPRD`.
      billable = false;
      reason = "in revocation grace at evaluation";
    } else if (!hasChannel) {
      billable = false;
      reason = "no authorised channel in period";
    } else if (!loggedIn && !hadDraft) {
      billable = false;
      reason = "no login or draft in period";
    } else {
      reason = explainBillable({ loggedIn, draftCount });
    }

    return {
      membership: m,
      hasAuthorisedChannel: hasChannel,
      loggedInThisPeriod: loggedIn,
      hadDraftThisPeriod: hadDraft,
      draftCount,
      isActiveByPRD: isActive,
      isBillable: billable,
      salesIdentifierApplies: billable && tenant.salesIdentifierEnabled,
      reason,
    };
  });
}

function explainBillable(x: { loggedIn: boolean; draftCount: number }): string {
  const parts: string[] = [];
  if (x.loggedIn) parts.push("logged in");
  if (x.draftCount > 0) parts.push(`${x.draftCount} draft${x.draftCount === 1 ? "" : "s"}`);
  return `billed (${parts.join(", ")})`;
}

// ─── Totals ────────────────────────────────────────────────────────────────

export type LineItem = {
  label: string;
  qty: number;
  unitMinor: number;
  subtotalMinor: number;
  note?: string;
};

export type Totals = {
  currency: string;
  activeUsers: number;
  billableUsers: number;
  salesIdUsers: number;
  baseSubtotalMinor: number;
  salesIdSubtotalMinor: number;
  cmkSubtotalMinor: number;
  totalMinor: number;
  lines: LineItem[];
  /** True when PRD §15.1 sandbox-free window applies to this period. */
  sandboxFreePeriod: boolean;
  sandboxFreeNote: string | null;
};

export function computeTotals(
  plan: Plan,
  rows: UserActivity[],
  periodEndExclusive: Date,
): Totals {
  const billable = rows.filter((r) => r.isBillable).length;
  const active = rows.filter((r) => r.isActiveByPRD).length;
  const siUsers = rows.filter((r) => r.salesIdentifierApplies).length;

  const baseSubtotal = billable * plan.baseMinor;
  const siUnit = effectiveSalesIdMinor(plan);
  const siSubtotal = siUsers * siUnit;
  const cmkSubtotal = plan.cmkEnabled ? plan.cmkMinor : 0;

  const lines: LineItem[] = [
    {
      label: "Base licence — per active User",
      qty: billable,
      unitMinor: plan.baseMinor,
      subtotalMinor: baseSubtotal,
      note: "PRD §15.1 base licence (FA/FCT roles do not attract additional fees).",
    },
  ];
  if (plan.salesIdEnabled) {
    const noteParts: string[] = [];
    if (plan.salesIdPartnerDefault) {
      noteParts.push(`-${plan.salesIdPartnerDiscountPct}% Acumon-default-Partner`);
    }
    if (plan.crossClientLearningOptIn) {
      noteParts.push(`-${plan.cclDiscountPct}% Cross-Client Learning opt-in`);
    }
    lines.push({
      label: "Sales Identifier add-on",
      qty: siUsers,
      unitMinor: siUnit,
      subtotalMinor: siSubtotal,
      note: noteParts.length ? `Effective rate: ${noteParts.join(", ")}.` : undefined,
    });
  }
  if (plan.cmkEnabled) {
    lines.push({
      label: "Customer-Managed Keys uplift",
      qty: 1,
      unitMinor: plan.cmkMinor,
      subtotalMinor: cmkSubtotal,
      note: "PRD §15.1 enterprise upgrade — flat per-tenant fee.",
    });
  }

  let total = baseSubtotal + siSubtotal + cmkSubtotal;
  let sandboxFree = false;
  let sandboxNote: string | null = null;
  if (plan.isSandbox && plan.sandboxBillingFreeUntil && plan.sandboxBillingFreeUntil >= periodEndExclusive) {
    // Sandbox tenants get the first 30 days included (PRD §15.1).
    sandboxFree = true;
    sandboxNote = `Sandbox free period through ${plan.sandboxBillingFreeUntil.toISOString().slice(0, 10)} — invoice waived.`;
    total = 0;
    lines.push({
      label: "Sandbox free period",
      qty: 1,
      unitMinor: -(baseSubtotal + siSubtotal + cmkSubtotal),
      subtotalMinor: -(baseSubtotal + siSubtotal + cmkSubtotal),
      note: sandboxNote,
    });
  }

  return {
    currency: plan.currency,
    activeUsers: active,
    billableUsers: billable,
    salesIdUsers: siUsers,
    baseSubtotalMinor: baseSubtotal,
    salesIdSubtotalMinor: siSubtotal,
    cmkSubtotalMinor: cmkSubtotal,
    totalMinor: total,
    lines,
    sandboxFreePeriod: sandboxFree,
    sandboxFreeNote: sandboxNote,
  };
}

// ─── Estimates and close ───────────────────────────────────────────────────

export type Estimate = {
  period: string;
  start: Date;
  end: Date;
  plan: Plan;
  rows: UserActivity[];
  totals: Totals;
  isCurrentMonth: boolean;
  evaluatedAt: Date;
};

export async function getEstimate({
  tenantId,
  period,
  now = new Date(),
}: {
  tenantId: string;
  period: string;
  now?: Date;
}): Promise<Estimate> {
  const tenant = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("billing: tenant not found");
  const { start, end } = periodBounds(period);
  const isCurrent = now >= start && now < end;
  const evalAsOf = isCurrent ? now : end;
  const plan = planFromTenant(tenant);
  const rows = await evaluateActivity({ tenant, start, end, evalAsOf });
  const totals = computeTotals(plan, rows, end);
  return { period, start, end, plan, rows, totals, isCurrentMonth: isCurrent, evaluatedAt: now };
}

export async function getCurrentEstimate(tenantId: string, now: Date = new Date()): Promise<Estimate> {
  return getEstimate({ tenantId, period: periodForDate(now), now });
}

export type ClosePeriodInput = {
  tenantId: string;
  period: string;
  actorMembershipId?: string | null;
  /**
   * Allow closing a period whose end is in the future. Defaults false; the
   * cron job uses the default and only closes months that have actually
   * ended. Manual close from the FA dashboard sets this true so the FA can
   * cut a partial-month invoice on demand.
   */
  allowFutureClose?: boolean;
  now?: Date;
};

export async function closeBillingPeriod(input: ClosePeriodInput) {
  const now = input.now ?? new Date();
  const { start, end } = periodBounds(input.period);
  if (!input.allowFutureClose && end > now) {
    throw new Error(
      `billing: period ${input.period} ends in the future (${end.toISOString().slice(0, 10)}); pass allowFutureClose to override`,
    );
  }
  const existing = await superDb.billingPeriod.findUnique({
    where: { tenantId_period: { tenantId: input.tenantId, period: input.period } },
  });
  if (existing && existing.status === "CLOSED") {
    return { period: existing, alreadyClosed: true as const };
  }

  const tenant = await superDb.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("billing: tenant not found");
  const plan = planFromTenant(tenant);
  const rows = await evaluateActivity({ tenant, start, end, evalAsOf: end });
  const totals = computeTotals(plan, rows, end);

  const payload: Prisma.InputJsonValue = {
    plan: serializePlan(plan),
    totals: serializeTotals(totals),
    breakdown: rows.map((r) => ({
      membershipId: r.membership.id,
      userEmail: r.membership.user.email,
      userName: r.membership.user.name,
      role: r.membership.role,
      status: r.membership.status,
      hasAuthorisedChannel: r.hasAuthorisedChannel,
      loggedInThisPeriod: r.loggedInThisPeriod,
      hadDraftThisPeriod: r.hadDraftThisPeriod,
      draftCount: r.draftCount,
      isActiveByPRD: r.isActiveByPRD,
      isBillable: r.isBillable,
      salesIdentifierApplies: r.salesIdentifierApplies,
      reason: r.reason,
    })),
  };

  const closed = await superDb.$transaction(async (tx) => {
    const period = await tx.billingPeriod.upsert({
      where: { tenantId_period: { tenantId: input.tenantId, period: input.period } },
      create: {
        tenantId: input.tenantId,
        period: input.period,
        status: "CLOSED",
        closedAt: now,
        closedByMembershipId: input.actorMembershipId ?? null,
        currency: totals.currency,
        activeUsers: totals.activeUsers,
        billableUsers: totals.billableUsers,
        salesIdUsers: totals.salesIdUsers,
        baseSubtotalMinor: totals.baseSubtotalMinor,
        salesIdSubtotalMinor: totals.salesIdSubtotalMinor,
        cmkSubtotalMinor: totals.cmkSubtotalMinor,
        totalMinor: totals.totalMinor,
        payload,
      },
      update: {
        status: "CLOSED",
        closedAt: now,
        closedByMembershipId: input.actorMembershipId ?? null,
        currency: totals.currency,
        activeUsers: totals.activeUsers,
        billableUsers: totals.billableUsers,
        salesIdUsers: totals.salesIdUsers,
        baseSubtotalMinor: totals.baseSubtotalMinor,
        salesIdSubtotalMinor: totals.salesIdSubtotalMinor,
        cmkSubtotalMinor: totals.cmkSubtotalMinor,
        totalMinor: totals.totalMinor,
        payload,
      },
    });

    // Replace any prior snapshots for this period (re-close case).
    await tx.billingUserSnapshot.deleteMany({ where: { periodId: period.id } });
    if (rows.length > 0) {
      await tx.billingUserSnapshot.createMany({
        data: rows.map((r) => ({
          tenantId: input.tenantId,
          periodId: period.id,
          membershipId: r.membership.id,
          userEmail: r.membership.user.email,
          role: r.membership.role,
          membershipStatus: r.membership.status,
          hasAuthorisedChannel: r.hasAuthorisedChannel,
          loggedInThisPeriod: r.loggedInThisPeriod,
          hadDraftThisPeriod: r.hadDraftThisPeriod,
          draftCount: r.draftCount,
          isActiveByPRD: r.isActiveByPRD,
          isBillable: r.isBillable,
          salesIdentifierApplies: r.salesIdentifierApplies,
          reason: r.reason,
        })),
      });
    }
    return period;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "BILLING_PERIOD_CLOSED",
    actorMembershipId: input.actorMembershipId ?? null,
    subjectType: "BillingPeriod",
    subjectId: closed.id,
    payload: {
      period: input.period,
      currency: totals.currency,
      billableUsers: totals.billableUsers,
      activeUsers: totals.activeUsers,
      salesIdUsers: totals.salesIdUsers,
      totalMinor: totals.totalMinor,
      sandboxFreePeriod: totals.sandboxFreePeriod,
    },
  });

  return { period: closed, alreadyClosed: false as const };
}

export async function reopenBillingPeriod({
  tenantId,
  period,
  actorMembershipId,
  reason,
}: {
  tenantId: string;
  period: string;
  actorMembershipId: string;
  reason: string;
}) {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("billing: reason required to reopen");
  const existing = await superDb.billingPeriod.findUnique({
    where: { tenantId_period: { tenantId, period } },
  });
  if (!existing) throw new Error(`billing: no period ${period} to reopen`);
  if (existing.status !== "CLOSED") return { period: existing, alreadyOpen: true as const };

  const updated = await superDb.billingPeriod.update({
    where: { id: existing.id },
    data: { status: "DRAFT", closedAt: null, closedByMembershipId: null },
  });
  await writeAuditEvent({
    tenantId,
    eventType: "BILLING_PERIOD_REOPENED",
    actorMembershipId,
    subjectType: "BillingPeriod",
    subjectId: existing.id,
    payload: { period, reason: trimmed },
  });
  return { period: updated, alreadyOpen: false as const };
}

// ─── Cron entry: close all due periods ─────────────────────────────────────

export type SweepResult = {
  closed: { tenantId: string; period: string; totalMinor: number; currency: string }[];
  skipped: { tenantId: string; period: string; reason: string }[];
};

/**
 * Close any tenant's previous-month BillingPeriod that hasn't been closed
 * yet. Idempotent — re-running the same day is a no-op for tenants whose
 * last period is already CLOSED.
 */
export async function closeAllDueBillingPeriods({ now = new Date() }: { now?: Date } = {}): Promise<SweepResult> {
  const period = previousPeriod(periodForDate(now));
  const tenants = await superDb.tenant.findMany({
    where: { status: { in: ["ACTIVE", "SANDBOX"] } },
    select: { id: true },
  });
  const result: SweepResult = { closed: [], skipped: [] };
  for (const t of tenants) {
    try {
      const r = await closeBillingPeriod({ tenantId: t.id, period, now });
      if (r.alreadyClosed) {
        result.skipped.push({ tenantId: t.id, period, reason: "already closed" });
      } else {
        result.closed.push({
          tenantId: t.id,
          period,
          totalMinor: r.period.totalMinor,
          currency: r.period.currency,
        });
      }
    } catch (e) {
      result.skipped.push({
        tenantId: t.id,
        period,
        reason: e instanceof Error ? e.message : "unknown error",
      });
    }
  }
  return result;
}

// ─── Plan updates ──────────────────────────────────────────────────────────

export type PlanUpdate = Partial<{
  pricingCurrency: string;
  pricingBaseMinor: number;
  pricingSalesIdMinor: number;
  pricingSalesIdPartnerDefault: boolean;
  pricingSalesIdPartnerDiscountPct: number;
  pricingCrossClientLearningOptIn: boolean;
  pricingCclDiscountPct: number;
  pricingCmkEnabled: boolean;
  pricingCmkMinor: number;
}>;

export async function updateTenantPlan({
  tenantId,
  actorMembershipId,
  updates,
}: {
  tenantId: string;
  actorMembershipId: string;
  updates: PlanUpdate;
}) {
  const before = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!before) throw new Error("billing: tenant not found");
  const sanitized: PlanUpdate = {};
  if (updates.pricingCurrency != null) sanitized.pricingCurrency = updates.pricingCurrency.toUpperCase().slice(0, 3);
  if (updates.pricingBaseMinor != null) sanitized.pricingBaseMinor = nonNegInt(updates.pricingBaseMinor);
  if (updates.pricingSalesIdMinor != null) sanitized.pricingSalesIdMinor = nonNegInt(updates.pricingSalesIdMinor);
  if (updates.pricingSalesIdPartnerDefault != null)
    sanitized.pricingSalesIdPartnerDefault = !!updates.pricingSalesIdPartnerDefault;
  if (updates.pricingSalesIdPartnerDiscountPct != null)
    sanitized.pricingSalesIdPartnerDiscountPct = clampPct(updates.pricingSalesIdPartnerDiscountPct);
  if (updates.pricingCrossClientLearningOptIn != null)
    sanitized.pricingCrossClientLearningOptIn = !!updates.pricingCrossClientLearningOptIn;
  if (updates.pricingCclDiscountPct != null)
    sanitized.pricingCclDiscountPct = clampPct(updates.pricingCclDiscountPct);
  if (updates.pricingCmkEnabled != null) sanitized.pricingCmkEnabled = !!updates.pricingCmkEnabled;
  if (updates.pricingCmkMinor != null) sanitized.pricingCmkMinor = nonNegInt(updates.pricingCmkMinor);

  const after = await superDb.tenant.update({ where: { id: tenantId }, data: sanitized });

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(sanitized) as (keyof PlanUpdate)[]) {
    const b = (before as unknown as Record<string, unknown>)[k];
    const a = (sanitized as Record<string, unknown>)[k];
    if (b !== a) diff[k] = { from: b, to: a };
  }

  if (Object.keys(diff).length > 0) {
    await writeAuditEvent({
      tenantId,
      eventType: "BILLING_PLAN_UPDATED",
      actorMembershipId,
      subjectType: "Tenant",
      subjectId: tenantId,
      payload: { changes: diff as Prisma.InputJsonValue },
    });
  }

  return after;
}

function nonNegInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

// ─── Serialisation helpers (for payload + JSON exports) ────────────────────

function serializePlan(p: Plan) {
  return {
    currency: p.currency,
    baseMinor: p.baseMinor,
    salesIdMinor: p.salesIdMinor,
    salesIdEnabled: p.salesIdEnabled,
    salesIdPartnerDefault: p.salesIdPartnerDefault,
    salesIdPartnerDiscountPct: p.salesIdPartnerDiscountPct,
    crossClientLearningOptIn: p.crossClientLearningOptIn,
    cclDiscountPct: p.cclDiscountPct,
    cmkEnabled: p.cmkEnabled,
    cmkMinor: p.cmkMinor,
    isSandbox: p.isSandbox,
    sandboxBillingFreeUntil: p.sandboxBillingFreeUntil ? p.sandboxBillingFreeUntil.toISOString() : null,
  };
}

function serializeTotals(t: Totals) {
  return {
    currency: t.currency,
    activeUsers: t.activeUsers,
    billableUsers: t.billableUsers,
    salesIdUsers: t.salesIdUsers,
    baseSubtotalMinor: t.baseSubtotalMinor,
    salesIdSubtotalMinor: t.salesIdSubtotalMinor,
    cmkSubtotalMinor: t.cmkSubtotalMinor,
    totalMinor: t.totalMinor,
    sandboxFreePeriod: t.sandboxFreePeriod,
    sandboxFreeNote: t.sandboxFreeNote,
    lines: t.lines,
  };
}

// ─── CSV ───────────────────────────────────────────────────────────────────

export function snapshotsToCsv(rows: {
  userEmail: string;
  role: Role;
  membershipStatus: string;
  hasAuthorisedChannel: boolean;
  loggedInThisPeriod: boolean;
  hadDraftThisPeriod: boolean;
  draftCount: number;
  isActiveByPRD: boolean;
  isBillable: boolean;
  salesIdentifierApplies: boolean;
  reason: string;
}[]): string {
  const header = [
    "userEmail",
    "role",
    "membershipStatus",
    "hasAuthorisedChannel",
    "loggedInThisPeriod",
    "hadDraftThisPeriod",
    "draftCount",
    "isActiveByPRD",
    "isBillable",
    "salesIdentifierApplies",
    "reason",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.userEmail),
        r.role,
        r.membershipStatus,
        r.hasAuthorisedChannel,
        r.loggedInThisPeriod,
        r.hadDraftThisPeriod,
        r.draftCount,
        r.isActiveByPRD,
        r.isBillable,
        r.salesIdentifierApplies,
        csvEscape(r.reason),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function csvEscape(s: string): string {
  if (s == null) return "";
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
