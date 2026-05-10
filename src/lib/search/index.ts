import type { Membership, Role, Tenant } from "@prisma/client";
import { reportError } from "@/lib/observability";
import {
  searchDrafts,
  searchActions,
  searchMeetings,
  searchOpportunities,
  searchMembers,
  searchAuditEvents,
  searchFcgRules,
  searchUcgRules,
  searchSubProcessors,
  searchProcessingActivities,
} from "./sources";

/**
 * Backlog item 8 — global ⌘K command palette. The runtime is a simple
 * fan-out: the API route calls `runSearch(...)` which calls every source
 * concurrently with a per-source cap, sorts the merged hits by score, and
 * truncates. Cross-tenant isolation is enforced inside each source —
 * tenant-scoped models go through `tenantDb` (RLS defence in depth),
 * global models (SubProcessor, ProcessingActivity) are read directly via
 * `superDb` because they have no `tenantId`.
 *
 * Scoring is intentionally simple:
 *   • exact-substring in the title field           → 100
 *   • exact-substring in a secondary field         →  50
 *   • all query tokens individually present        →  20
 * Recency adds a small bonus (≤ 10 points) so a same-relevance hit on a
 * recent row floats above a cold one. We don't need IR-grade ranking for
 * a navigation palette — the user types until they see what they want.
 */

export type SearchKind =
  | "draft"
  | "action"
  | "meeting"
  | "opportunity"
  | "member"
  | "audit"
  | "fcg-rule"
  | "ucg-rule"
  | "sub-processor"
  | "processing-activity";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
  /// Optional bucket label for the UI section header.
  group?: string;
  /// Optional ISO timestamp for relative-time rendering in the palette.
  timestamp?: string;
};

export type SearchInput = {
  q: string;
  tenant: Tenant;
  membership: Membership;
  /// Per-source cap — keeps the result list manageable. Default 6 each.
  perSourceLimit?: number;
};

export type SearchResult = {
  q: string;
  hits: SearchHit[];
  /// True if the query was too short to fan out (returns []).
  skipped: boolean;
};

const MIN_QUERY_LENGTH = 2;
const DEFAULT_PER_SOURCE = 6;
const TOTAL_LIMIT = 40;

export async function runSearch(input: SearchInput): Promise<SearchResult> {
  const q = input.q.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { q, hits: [], skipped: true };
  }

  const limit = input.perSourceLimit ?? DEFAULT_PER_SOURCE;
  const ctx = {
    q,
    tenantId: input.tenant.id,
    tenantSlug: input.tenant.slug,
    membershipId: input.membership.id,
    role: input.membership.role,
    limit,
  };

  // Fan out — every source is independent and any single failure must not
  // poison the rest. A draft-table glitch shouldn't lose the user their
  // member-search results.
  const sourceFns: Array<{ name: SearchKind; fn: () => Promise<SearchHit[]> }> = [
    { name: "draft", fn: () => searchDrafts(ctx) },
    { name: "action", fn: () => searchActions(ctx) },
    { name: "meeting", fn: () => searchMeetings(ctx) },
    { name: "opportunity", fn: () => searchOpportunities(ctx) },
    { name: "member", fn: () => searchMembers(ctx) },
    { name: "audit", fn: () => searchAuditEvents(ctx) },
    { name: "fcg-rule", fn: () => searchFcgRules(ctx) },
    { name: "ucg-rule", fn: () => searchUcgRules(ctx) },
    { name: "sub-processor", fn: () => searchSubProcessors(ctx) },
    { name: "processing-activity", fn: () => searchProcessingActivities(ctx) },
  ];

  const settled = await Promise.allSettled(sourceFns.map((s) => s.fn()));
  const hits: SearchHit[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i]!;
    const meta = sourceFns[i]!;
    if (r.status === "fulfilled") {
      hits.push(...r.value);
    } else {
      reportError(r.reason, {
        route: "lib/search",
        tenantId: input.tenant.id,
        extra: { source: meta.name },
      }, `search source ${meta.name} failed`);
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { q, hits: hits.slice(0, TOTAL_LIMIT), skipped: false };
}

export type SearchSourceCtx = {
  q: string;
  tenantId: string;
  tenantSlug: string;
  membershipId: string;
  role: Role;
  limit: number;
};

/**
 * Score helper used by sources. `title` is the primary field; `secondary`
 * are additional fields (body, sender, etc.) that contribute less weight.
 * `recencyTs` adds up to 10 points based on age relative to a 1-year window.
 */
export function scoreHit(opts: {
  q: string;
  title: string | null | undefined;
  secondary?: Array<string | null | undefined>;
  recencyTs?: Date | null;
}): number {
  const q = opts.q.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const title = (opts.title ?? "").toLowerCase();
  const secondary = (opts.secondary ?? []).map((s) => (s ?? "").toLowerCase());

  let score = 0;
  if (title.includes(q)) score += 100;
  for (const s of secondary) {
    if (s.includes(q)) {
      score += 50;
      break;
    }
  }
  if (score === 0) {
    // No exact-substring hit — count token coverage. A 3-token query that
    // matches all 3 tokens individually still surfaces (just below exact).
    let allMatched = true;
    const haystack = [title, ...secondary].join(" ");
    for (const t of tokens) {
      if (!haystack.includes(t)) {
        allMatched = false;
        break;
      }
    }
    if (allMatched && tokens.length > 1) score += 20;
  }

  if (score > 0 && opts.recencyTs) {
    const ageMs = Date.now() - opts.recencyTs.getTime();
    const oneYear = 365 * 24 * 3600 * 1000;
    const fresh = Math.max(0, 1 - ageMs / oneYear);
    score += fresh * 10;
  }
  return score;
}

/**
 * Build a Prisma-style ILIKE filter array. Returns an array suitable for
 * `OR:` containing one `contains` clause per (field × token) pair, plus
 * a single multi-token catch-all on the joined query. Works across
 * Postgres-backed Prisma fields with mode: 'insensitive'.
 */
export function ilikeOr(
  q: string,
  fields: string[],
): Array<Record<string, { contains: string; mode: "insensitive" }>> {
  return fields.map((f) => ({
    [f]: { contains: q, mode: "insensitive" as const },
  }));
}

export type { Membership, Tenant };
