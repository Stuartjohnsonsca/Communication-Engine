import type {
  FCGProposal,
  Membership,
  Prisma,
  SandboxOutcome,
  Tenant,
} from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * PRD §14.2 Sandbox / Dry-Run.
 *
 * A Sandbox is a separate Tenant row (`isSandbox = true`, `parentTenantId` =
 * production tenant). The cohort is up to 10 users by default; the window is
 * 30 days by default. The Sandbox runs the same drafting / FCG flows as
 * production (same code, same RLS) — just inside its own tenant boundary,
 * so production communications are unaffected.
 *
 * On conclusion the Client either PROMOTES the candidate FCG to production
 * (a normal §6 governance proposal is staged on the parent — the parent's
 * FCT votes on it, we don't bypass governance), ITERATES (closes the window
 * and opens a new one), or DECLINES.
 *
 * All audit events are written against the *operator's* tenant chain — the
 * parent tenant, since that's where the operator who provisioned/concluded
 * the sandbox sits.
 */

const DEFAULT_DURATION_DAYS = 30;
const MAX_DURATION_DAYS = 180;
const MAX_COHORT = 50;

const SANDBOX_SLUG_SUFFIX = "-sandbox";

// ─── Provisioning ─────────────────────────────────────────────────────────

export type ProvisionSandboxInput = {
  parentTenantId: string;
  /** Operator's membership on the parent tenant. */
  actorMembershipId: string;
  durationDays?: number;
  cohortLimit?: number;
};

export async function provisionSandbox(input: ProvisionSandboxInput): Promise<Tenant> {
  const parent = await superDb.tenant.findUnique({ where: { id: input.parentTenantId } });
  if (!parent) throw new Error("sandbox: parent tenant not found");
  if (parent.isSandbox) throw new Error("sandbox: cannot provision a sandbox of a sandbox");

  // Refuse if the parent already has an open sandbox — PRD wording is "a
  // Sandbox" (singular). Closing the existing one is a separate operator
  // action.
  const existing = await superDb.tenant.findFirst({
    where: {
      parentTenantId: parent.id,
      isSandbox: true,
      sandboxOutcome: "PENDING",
    },
  });
  if (existing) {
    throw new Error("sandbox: an open sandbox already exists — conclude it before opening another");
  }

  const durationDays = clampInt(input.durationDays ?? DEFAULT_DURATION_DAYS, 1, MAX_DURATION_DAYS);
  const cohortLimit = clampInt(input.cohortLimit ?? 10, 1, MAX_COHORT);

  const slug = await pickSandboxSlug(parent.slug);
  const now = new Date();
  const closesAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  // Inherit a sensible posture from the parent: same jurisdiction + voting
  // window. Sales Identifier and Cross-Client Learning stay OFF in the
  // sandbox by default — the sandbox is for evaluating culture / drafting,
  // not for running production-side processing purposes.
  const sandbox = await superDb.tenant.create({
    data: {
      slug,
      name: `${parent.name} (sandbox)`,
      jurisdiction: parent.jurisdiction,
      status: "SANDBOX",
      isSandbox: true,
      parentTenantId: parent.id,
      retentionDays: parent.retentionDays,
      quorumPct: parent.quorumPct,
      votingWindowDays: parent.votingWindowDays,
      sandboxOpenedAt: now,
      sandboxClosesAt: closesAt,
      sandboxCohortLimit: cohortLimit,
      sandboxOutcome: "PENDING",
      // Sandbox tenants are billing-free for the first 30 days per §15.1.
      sandboxBillingFreeUntil: closesAt,
    },
  });

  // Audit on the *parent* chain — the operator action sits in production's
  // governance log, which is the chain DPOs / FCT consult.
  await writeAuditEvent({
    tenantId: parent.id,
    eventType: "SANDBOX_PROVISIONED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: sandbox.id,
    payload: {
      sandboxSlug: sandbox.slug,
      durationDays,
      cohortLimit,
      closesAt: closesAt.toISOString(),
    },
  });

  return sandbox;
}

async function pickSandboxSlug(parentSlug: string): Promise<string> {
  const base = `${parentSlug}${SANDBOX_SLUG_SUFFIX}`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const taken = await superDb.tenant.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  throw new Error("sandbox: could not pick a unique slug after 50 tries");
}

// ─── Cohort ───────────────────────────────────────────────────────────────

export type AddCohortMemberInput = {
  sandboxTenantId: string;
  /** User to add — must already exist (resolved by email, case-insensitive). */
  email: string;
  role?: "USER" | "FCT_MEMBER" | "FIRM_ADMIN";
  /** Operator's membership on the parent tenant. */
  actorMembershipId: string;
  parentTenantId: string;
};

export async function addCohortMember(input: AddCohortMemberInput): Promise<Membership> {
  const sandbox = await assertSandbox(input.sandboxTenantId);
  if (sandbox.parentTenantId !== input.parentTenantId) {
    throw new Error("sandbox: parent mismatch");
  }
  if (sandbox.sandboxOutcome !== "PENDING") {
    throw new Error("sandbox: cohort is closed (window already concluded)");
  }
  if (sandbox.sandboxClosesAt && sandbox.sandboxClosesAt.getTime() < Date.now()) {
    throw new Error("sandbox: cohort window has elapsed; conclude or extend first");
  }

  const cohortCount = await superDb.membership.count({
    where: { tenantId: sandbox.id, status: { in: ["ACTIVE", "INVITED"] } },
  });
  if (cohortCount >= sandbox.sandboxCohortLimit) {
    throw new Error(`sandbox: cohort limit of ${sandbox.sandboxCohortLimit} reached`);
  }

  const email = input.email.trim().toLowerCase();
  const user = await superDb.user.findUnique({ where: { email } });
  if (!user) throw new Error(`sandbox: user with email ${email} not found — invite to platform first`);

  const existing = await superDb.membership.findUnique({
    where: { tenantId_userId: { tenantId: sandbox.id, userId: user.id } },
  });
  if (existing) {
    if (existing.status !== "ACTIVE") {
      const reactivated = await superDb.membership.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", role: input.role ?? existing.role },
      });
      await writeAuditEvent({
        tenantId: input.parentTenantId,
        eventType: "SANDBOX_MEMBER_ADDED",
        actorMembershipId: input.actorMembershipId,
        subjectType: "Membership",
        subjectId: reactivated.id,
        payload: {
          sandboxTenantId: sandbox.id,
          userEmail: email,
          reactivated: true,
        },
      });
      return reactivated;
    }
    return existing;
  }

  const membership = await superDb.membership.create({
    data: {
      tenantId: sandbox.id,
      userId: user.id,
      role: input.role ?? "USER",
      status: "ACTIVE",
    },
  });

  await writeAuditEvent({
    tenantId: input.parentTenantId,
    eventType: "SANDBOX_MEMBER_ADDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Membership",
    subjectId: membership.id,
    payload: {
      sandboxTenantId: sandbox.id,
      userEmail: email,
      role: membership.role,
    },
  });

  return membership;
}

// ─── Outcomes ─────────────────────────────────────────────────────────────

export type ConcludeInput = {
  sandboxTenantId: string;
  parentTenantId: string;
  outcome: Exclude<SandboxOutcome, "PENDING">;
  byName: string;
  notes?: string | null;
  /** Required when outcome = PROMOTED: which sandbox FCG to lift. */
  promotedFcgId?: string;
  actorMembershipId: string;
};

export async function concludeSandbox(input: ConcludeInput): Promise<{
  sandbox: Tenant;
  parentProposal?: FCGProposal;
}> {
  const sandbox = await assertSandbox(input.sandboxTenantId);
  if (sandbox.parentTenantId !== input.parentTenantId) {
    throw new Error("sandbox: parent mismatch");
  }
  if (sandbox.sandboxOutcome !== "PENDING") {
    throw new Error("sandbox: already concluded");
  }
  if (!input.byName.trim()) throw new Error("sandbox: signer name required");

  let parentProposal: FCGProposal | undefined;
  let promotedFcgId: string | null = null;
  let promotedProposalId: string | null = null;

  if (input.outcome === "PROMOTED") {
    if (!input.promotedFcgId) {
      throw new Error("sandbox: PROMOTED requires the FCG id to lift");
    }
    parentProposal = await stagePromotionProposal({
      sandboxTenantId: sandbox.id,
      parentTenantId: input.parentTenantId,
      sandboxFcgId: input.promotedFcgId,
      proposerMembershipId: input.actorMembershipId,
    });
    promotedFcgId = input.promotedFcgId;
    promotedProposalId = parentProposal.id;
  }

  const data: Prisma.TenantUpdateInput = {
    sandboxOutcome: input.outcome,
    sandboxOutcomeAt: new Date(),
    sandboxOutcomeByName: input.byName.trim(),
    sandboxOutcomeNotes: input.notes?.trim() || null,
    sandboxPromotedFcgId: promotedFcgId,
    sandboxPromotedProposalId: promotedProposalId,
    // PRD §14.2: declined sandboxes "exit". Mark the tenant terminated so it
    // stops appearing in active lists and the cohort can no longer log in.
    // PROMOTED / ITERATING leave the sandbox tenant ACTIVE for record-keeping;
    // the outcome flag is the single source of truth for "is the window open".
    ...(input.outcome === "DECLINED" ? { status: "TERMINATED" } : {}),
  };

  const updated = await superDb.tenant.update({
    where: { id: sandbox.id },
    data,
  });

  if (parentProposal) {
    await writeAuditEvent({
      tenantId: input.parentTenantId,
      eventType: "SANDBOX_FCG_PROMOTED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "FCGProposal",
      subjectId: parentProposal.id,
      payload: {
        sandboxTenantId: sandbox.id,
        sandboxFcgId: input.promotedFcgId,
      },
    });
  }

  await writeAuditEvent({
    tenantId: input.parentTenantId,
    eventType: "SANDBOX_OUTCOME_RECORDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: sandbox.id,
    payload: {
      outcome: input.outcome,
      byName: input.byName.trim(),
      hadNotes: !!input.notes?.trim(),
      sandboxFcgId: input.promotedFcgId ?? null,
      parentProposalId: promotedProposalId,
    },
  });

  return { sandbox: updated, parentProposal };
}

/**
 * Stages a §6 governance proposal on the parent tenant from a sandbox FCG.
 * The parent's FCT then votes on it through the normal flow — promotion is
 * never silent.
 *
 * The proposal `diff.ops` is built by treating each rule in the sandbox FCG
 * as a `propose_rule_change` op with action `add`. If the parent already has
 * a committed FCG, those add ops will collide with existing rules; the FCT
 * can refine through their normal chat/edit before opening for vote.
 */
async function stagePromotionProposal(input: {
  sandboxTenantId: string;
  parentTenantId: string;
  sandboxFcgId: string;
  proposerMembershipId: string;
}): Promise<FCGProposal> {
  const sandboxFcg = await superDb.firmCultureGuide.findFirst({
    where: { id: input.sandboxFcgId, tenantId: input.sandboxTenantId },
    include: { rules: { orderBy: { priority: "asc" } } },
  });
  if (!sandboxFcg) throw new Error("sandbox: chosen FCG not found in this sandbox");

  const parentCurrent = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: input.parentTenantId, status: "COMMITTED" },
    orderBy: { version: "desc" },
  });

  const ops = sandboxFcg.rules.map((r) => ({
    tool: "propose_rule_change" as const,
    input: {
      action: "add",
      rule: {
        externalId: r.externalId,
        category: r.category,
        channel: r.channel,
        statement: r.statement,
        payload: r.payload,
        rationale: r.rationale,
        mandatory: r.mandatory,
        priority: r.priority,
        evidenceRefs: r.evidenceRefs,
        channelOverrides: r.channelOverrides,
      },
      rationale: `Lifted from sandbox FCG v${sandboxFcg.version}`,
    },
  }));

  return superDb.fCGProposal.create({
    data: {
      tenantId: input.parentTenantId,
      parentFcgId: parentCurrent?.id ?? null,
      title: `Sandbox promotion — FCG v${sandboxFcg.version}`,
      body:
        `Candidate FCG promoted from sandbox dry-run. ` +
        `${sandboxFcg.rules.length} rule${sandboxFcg.rules.length === 1 ? "" : "s"} ` +
        `staged for the FCT to review and open for vote.`,
      diff: { ops } as unknown as Prisma.InputJsonValue,
      proposedById: input.proposerMembershipId,
      state: "DRAFTING",
    },
  });
}

// ─── Views ────────────────────────────────────────────────────────────────

export type SandboxView = {
  sandbox: Tenant | null;
  /** Memberships in the sandbox cohort (active + invited). */
  cohort: (Membership & { user: { email: string; name: string | null } })[];
  /** FCG candidates in the sandbox — the operator picks one to promote. */
  fcgCandidates: { id: string; version: number; status: string; ruleCount: number }[];
};

export async function getSandboxView(parentTenantId: string): Promise<SandboxView> {
  const sandbox = await superDb.tenant.findFirst({
    where: { parentTenantId, isSandbox: true },
    orderBy: { createdAt: "desc" },
  });
  if (!sandbox) return { sandbox: null, cohort: [], fcgCandidates: [] };

  const [cohort, fcgs] = await Promise.all([
    superDb.membership.findMany({
      where: { tenantId: sandbox.id, status: { in: ["ACTIVE", "INVITED"] } },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    superDb.firmCultureGuide.findMany({
      where: { tenantId: sandbox.id },
      orderBy: { version: "desc" },
      include: { _count: { select: { rules: true } } },
      take: 10,
    }),
  ]);

  return {
    sandbox,
    cohort,
    fcgCandidates: fcgs.map((f) => ({
      id: f.id,
      version: f.version,
      status: f.status,
      ruleCount: f._count.rules,
    })),
  };
}

// ─── Internals ────────────────────────────────────────────────────────────

async function assertSandbox(tenantId: string): Promise<Tenant> {
  const t = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!t) throw new Error("sandbox: not found");
  if (!t.isSandbox) throw new Error("sandbox: target tenant is not a sandbox");
  return t;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
