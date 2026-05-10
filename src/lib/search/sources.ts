import { superDb, tenantDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import type { SearchHit, SearchSourceCtx } from "./index";
import { ilikeOr, scoreHit } from "./index";

/**
 * Per-entity search sources for the ⌘K palette. Each function returns at
 * most `ctx.limit` hits. Tenant-scoped models go through `tenantDb` (RLS
 * defence in depth). Global models use `superDb` directly because they
 * have no tenantId by design (see `prisma/rls.sql tenant_tables`).
 *
 * Permission gating mirrors the nav: USER sees their own drafts/actions
 * etc.; FCT_MEMBER + FIRM_ADMIN widen to firm-wide. Audit events require
 * `audit:read`; processing-map requires `processing-map:read`. If a User
 * lacks the gate, the source returns `[]` rather than 403ing the whole
 * search response.
 */

const truncate = (s: string | null | undefined, n = 80) => {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
};

export async function searchDrafts(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  const canSeeFirmWide = hasPermission(ctx.role, "members:read");
  const where = canSeeFirmWide
    ? {
        tenantId: ctx.tenantId,
        OR: ilikeOr(ctx.q, ["subject", "body", "inboundSubject", "inboundSender"]),
      }
    : {
        tenantId: ctx.tenantId,
        membershipId: ctx.membershipId,
        OR: ilikeOr(ctx.q, ["subject", "body", "inboundSubject", "inboundSender"]),
      };
  const rows = await tenantDb(ctx.tenantId).draft.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: ctx.limit,
    select: {
      id: true,
      subject: true,
      body: true,
      status: true,
      kind: true,
      channel: true,
      createdAt: true,
      inboundSubject: true,
    },
  });
  return rows.map((r) => ({
    kind: "draft" as const,
    id: r.id,
    title: r.subject || r.inboundSubject || "(no subject)",
    subtitle: `${r.status} · ${r.kind} · ${truncate(r.body, 60)}`,
    href: `/${ctx.tenantSlug}/drafts/${r.id}`,
    score: scoreHit({
      q: ctx.q,
      title: r.subject ?? r.inboundSubject,
      secondary: [r.body, r.inboundSubject],
      recencyTs: r.createdAt,
    }),
    group: "Drafts",
    timestamp: r.createdAt.toISOString(),
  }));
}

export async function searchActions(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  const canSeeFirmWide = hasPermission(ctx.role, "members:read");
  const where = canSeeFirmWide
    ? {
        tenantId: ctx.tenantId,
        OR: ilikeOr(ctx.q, ["title", "detail"]),
      }
    : {
        tenantId: ctx.tenantId,
        membershipId: ctx.membershipId,
        OR: ilikeOr(ctx.q, ["title", "detail"]),
      };
  const rows = await tenantDb(ctx.tenantId).action.findMany({
    where,
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    take: ctx.limit,
    select: {
      id: true,
      title: true,
      detail: true,
      status: true,
      type: true,
      dueAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    kind: "action" as const,
    id: r.id,
    title: r.title,
    subtitle: `${r.status} · ${r.type}${
      r.dueAt ? ` · due ${r.dueAt.toISOString().slice(0, 10)}` : ""
    }${r.detail ? ` · ${truncate(r.detail, 60)}` : ""}`,
    href: `/${ctx.tenantSlug}/actions`,
    score: scoreHit({
      q: ctx.q,
      title: r.title,
      secondary: [r.detail],
      recencyTs: r.createdAt,
    }),
    group: "Actions",
    timestamp: r.createdAt.toISOString(),
  }));
}

export async function searchMeetings(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  const rows = await tenantDb(ctx.tenantId).meeting.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: ilikeOr(ctx.q, ["title", "description", "location"]),
    },
    orderBy: { startsAt: "desc" },
    take: ctx.limit,
    select: {
      id: true,
      title: true,
      description: true,
      location: true,
      startsAt: true,
      paperStatus: true,
    },
  });
  return rows.map((r) => ({
    kind: "meeting" as const,
    id: r.id,
    title: r.title,
    subtitle: `${r.startsAt.toISOString().slice(0, 16).replace("T", " ")} · paper ${r.paperStatus}${
      r.location ? ` · ${r.location}` : ""
    }`,
    href: `/${ctx.tenantSlug}/meetings/${r.id}`,
    score: scoreHit({
      q: ctx.q,
      title: r.title,
      secondary: [r.description, r.location],
      recencyTs: r.startsAt,
    }),
    group: "Meetings",
    timestamp: r.startsAt.toISOString(),
  }));
}

export async function searchOpportunities(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  const rows = await tenantDb(ctx.tenantId).opportunityCandidate.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: ilikeOr(ctx.q, [
        "rationale",
        "jurisdiction",
        "serviceLine",
        "classification",
        "suggestedReviewerTeam",
        "decisionReason",
      ]),
    },
    orderBy: { createdAt: "desc" },
    take: ctx.limit,
    select: {
      id: true,
      classification: true,
      status: true,
      jurisdiction: true,
      serviceLine: true,
      rationale: true,
      createdAt: true,
      sourceMessage: { select: { subject: true, sender: true } },
    },
  });
  return rows.map((r) => {
    const titleBase =
      r.sourceMessage?.subject || r.classification || r.serviceLine || r.jurisdiction || "Opportunity";
    return {
      kind: "opportunity" as const,
      id: r.id,
      title: titleBase,
      subtitle: `${r.status}${r.classification ? ` · ${r.classification}` : ""}${
        r.jurisdiction ? ` · ${r.jurisdiction}` : ""
      }${r.rationale ? ` · ${truncate(r.rationale, 60)}` : ""}`,
      href: `/${ctx.tenantSlug}/opportunities/${r.id}`,
      score: scoreHit({
        q: ctx.q,
        title: titleBase,
        secondary: [
          r.rationale,
          r.jurisdiction,
          r.serviceLine,
          r.classification,
          r.sourceMessage?.subject,
          r.sourceMessage?.sender,
        ],
        recencyTs: r.createdAt,
      }),
      group: "Opportunities",
      timestamp: r.createdAt.toISOString(),
    };
  });
}

export async function searchMembers(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  if (!hasPermission(ctx.role, "members:read")) return [];
  // Membership joins User; we filter on user.email/name. tenantDb scopes
  // membership by RLS automatically.
  const rows = await tenantDb(ctx.tenantId).membership.findMany({
    where: {
      tenantId: ctx.tenantId,
      user: {
        OR: [
          { email: { contains: ctx.q, mode: "insensitive" } },
          { name: { contains: ctx.q, mode: "insensitive" } },
        ],
      },
    },
    orderBy: { joinedAt: "asc" },
    take: ctx.limit,
    select: {
      id: true,
      role: true,
      status: true,
      joinedAt: true,
      user: { select: { email: true, name: true } },
    },
  });
  return rows.map((r) => ({
    kind: "member" as const,
    id: r.id,
    title: r.user.name || r.user.email,
    subtitle: `${r.role} · ${r.status} · ${r.user.email}`,
    href: `/${ctx.tenantSlug}/admin/members`,
    score: scoreHit({
      q: ctx.q,
      title: r.user.name,
      secondary: [r.user.email],
      recencyTs: r.joinedAt,
    }),
    group: "Members",
    timestamp: r.joinedAt.toISOString(),
  }));
}

export async function searchAuditEvents(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  if (!hasPermission(ctx.role, "audit:read")) return [];
  // AuditEvent payload is JSON — Postgres can search inside with
  // jsonb_path_exists, but for the palette we keep it simple and search
  // eventType + subjectType + subjectId. Most queries are by event name
  // ("ADHERENCE_ESCALATED") or subject id prefix.
  const rows = await tenantDb(ctx.tenantId).auditEvent.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { subjectType: { contains: ctx.q, mode: "insensitive" } },
        { subjectId: { contains: ctx.q, mode: "insensitive" } },
        // eventType is an enum — Prisma doesn't support `contains` on enums,
        // so fall back to `equals` against an upper-cased query if it looks
        // like an event-type token. The user types "ADHERENCE_ESCALATED" or
        // similar to find an event by name.
        ...(/^[A-Z][A-Z_0-9]+$/.test(ctx.q.trim().toUpperCase())
          ? [{ eventType: { equals: ctx.q.trim().toUpperCase() as never } }]
          : []),
      ],
    },
    orderBy: { seq: "desc" },
    take: ctx.limit,
    select: {
      id: true,
      seq: true,
      eventType: true,
      subjectType: true,
      subjectId: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    kind: "audit" as const,
    id: r.id,
    title: `${r.eventType}`,
    subtitle: `#${r.seq.toString()} · ${r.subjectType} ${r.subjectId.slice(0, 10)} · ${r.createdAt
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")}`,
    href: `/${ctx.tenantSlug}/admin/audit`,
    score: scoreHit({
      q: ctx.q,
      title: r.eventType,
      secondary: [r.subjectType, r.subjectId],
      recencyTs: r.createdAt,
    }),
    group: "Audit log",
    timestamp: r.createdAt.toISOString(),
  }));
}

export async function searchFcgRules(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  if (!hasPermission(ctx.role, "fcg:read")) return [];
  const rows = await tenantDb(ctx.tenantId).fCGRule.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { externalId: { contains: ctx.q, mode: "insensitive" } },
        { statement: { contains: ctx.q, mode: "insensitive" } },
        { rationale: { contains: ctx.q, mode: "insensitive" } },
      ],
      // Prefer the COMMITTED (active) FCG; lineage is fine as fallback.
      fcg: { status: "COMMITTED" },
    },
    take: ctx.limit,
    select: {
      id: true,
      externalId: true,
      statement: true,
      rationale: true,
      category: true,
      channel: true,
      mandatory: true,
      fcg: { select: { version: true, status: true } },
    },
  });
  return rows.map((r) => ({
    kind: "fcg-rule" as const,
    id: r.id,
    title: r.statement,
    subtitle: `${r.externalId} · ${r.category} · ${r.channel}${r.mandatory ? " · mandatory" : ""} · FCG v${r.fcg.version}`,
    href: `/${ctx.tenantSlug}/fcg`,
    score: scoreHit({
      q: ctx.q,
      title: r.statement,
      secondary: [r.externalId, r.rationale],
    }),
    group: "FCG rules",
  }));
}

export async function searchUcgRules(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  // USER + SALES_REVIEWER only see their own UCG rules; FCT/FIRM_ADMIN can
  // see any. ucg:read:any is the FCT/admin gate; ucg:read:self is everyone.
  const canSeeAny = hasPermission(ctx.role, "ucg:read:any");
  if (!canSeeAny && !hasPermission(ctx.role, "ucg:read:self")) return [];
  const rows = await tenantDb(ctx.tenantId).uCGRule.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(canSeeAny
        ? {}
        : { ucg: { membershipId: ctx.membershipId } }),
      OR: [
        { externalId: { contains: ctx.q, mode: "insensitive" } },
        { statement: { contains: ctx.q, mode: "insensitive" } },
      ],
    },
    take: ctx.limit,
    select: {
      id: true,
      externalId: true,
      statement: true,
      category: true,
      channel: true,
      suspendedAt: true,
      ucg: {
        select: {
          version: true,
          status: true,
          membershipId: true,
          membership: { select: { user: { select: { email: true, name: true } } } },
        },
      },
    },
  });
  return rows.map((r) => {
    const ownerEmail = r.ucg.membership.user.email;
    return {
      kind: "ucg-rule" as const,
      id: r.id,
      title: r.statement,
      subtitle: `${r.externalId} · ${r.category} · ${r.channel}${
        r.suspendedAt ? " · suspended" : ""
      } · ${ownerEmail}`,
      href: `/${ctx.tenantSlug}/ucg`,
      score: scoreHit({
        q: ctx.q,
        title: r.statement,
        secondary: [r.externalId, ownerEmail],
      }),
      group: "UCG rules",
    };
  });
}

export async function searchSubProcessors(ctx: SearchSourceCtx): Promise<SearchHit[]> {
  // Universal-read per `switching:read`. Uses superDb because SubProcessor
  // is a global model with no tenantId.
  const rows = await superDb.subProcessor.findMany({
    where: {
      OR: [
        { code: { contains: ctx.q, mode: "insensitive" } },
        { name: { contains: ctx.q, mode: "insensitive" } },
        { role: { contains: ctx.q, mode: "insensitive" } },
        { jurisdiction: { contains: ctx.q, mode: "insensitive" } },
        { notes: { contains: ctx.q, mode: "insensitive" } },
      ],
    },
    orderBy: { ordinal: "asc" },
    take: ctx.limit,
    select: {
      id: true,
      code: true,
      name: true,
      role: true,
      jurisdiction: true,
      isActive: true,
    },
  });
  return rows.map((r) => ({
    kind: "sub-processor" as const,
    id: r.id,
    title: r.name,
    subtitle: `${r.code} · ${r.role} · ${r.jurisdiction}${r.isActive ? "" : " · removed"}`,
    href: `/${ctx.tenantSlug}/switching`,
    score: scoreHit({
      q: ctx.q,
      title: r.name,
      secondary: [r.code, r.role, r.jurisdiction],
    }),
    group: "Sub-processors",
  }));
}

export async function searchProcessingActivities(
  ctx: SearchSourceCtx,
): Promise<SearchHit[]> {
  if (!hasPermission(ctx.role, "processing-map:read")) return [];
  const rows = await superDb.processingActivity.findMany({
    where: {
      OR: [
        { code: { contains: ctx.q, mode: "insensitive" } },
        { label: { contains: ctx.q, mode: "insensitive" } },
        { controller: { contains: ctx.q, mode: "insensitive" } },
        { processor: { contains: ctx.q, mode: "insensitive" } },
        { lawfulBasis: { contains: ctx.q, mode: "insensitive" } },
        { contract: { contains: ctx.q, mode: "insensitive" } },
        { notes: { contains: ctx.q, mode: "insensitive" } },
      ],
    },
    orderBy: { ordinal: "asc" },
    take: ctx.limit,
    select: {
      id: true,
      code: true,
      label: true,
      controller: true,
      processor: true,
      lawfulBasis: true,
    },
  });
  return rows.map((r) => ({
    kind: "processing-activity" as const,
    id: r.id,
    title: r.label,
    subtitle: `${r.code} · controller ${r.controller} · processor ${r.processor}${
      r.lawfulBasis ? ` · ${r.lawfulBasis}` : ""
    }`,
    href: `/${ctx.tenantSlug}/compliance/processing-map`,
    score: scoreHit({
      q: ctx.q,
      title: r.label,
      secondary: [r.code, r.controller, r.processor, r.lawfulBasis],
    }),
    group: "Processing activities",
  }));
}
