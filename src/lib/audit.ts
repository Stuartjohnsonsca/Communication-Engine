import { createHash } from "node:crypto";
import { Prisma, type AuditEventType } from "@prisma/client";
import { superDb } from "@/lib/db";
// `webhooks/dispatch` only imports superDb + observability — no circular
// edge back into this file. Kept as a sibling import so a future refactor
// that adds a transitive dependency on @/lib/audit will fail loudly at the
// dependency graph rather than silently at runtime.
import { enqueueWebhooks } from "@/lib/webhooks/dispatch";

const SEED = process.env.AUDIT_HASH_SEED ?? "acumon-genesis-2026";

const WEBHOOK_SELF_EVENT_TYPES = new Set<AuditEventType>([
  "WEBHOOK_DELIVERED",
  "WEBHOOK_DELIVERY_FAILED",
  "WEBHOOK_DEAD_LETTERED",
  "WEBHOOK_REPLAYED",
  "WEBHOOK_SUBSCRIPTION_AUTO_DISABLED",
  // Post-PRD: the test-fire path creates its own targeted WebhookDelivery
  // row for a single subscription and writes this audit as a forensic
  // record only. Excluding it from fan-out prevents the test from
  // accidentally firing at every other matching subscription.
  "WEBHOOK_SUBSCRIPTION_TESTED",
]);

export type WriteAuditInput = {
  tenantId: string;
  eventType: AuditEventType;
  actorMembershipId?: string | null;
  subjectType: string;
  subjectId: string;
  payload: Prisma.InputJsonValue;
};

/**
 * Append an event to the tenant's audit chain.
 *
 * Per PRD §6.2 the chain is:
 *   hash_n = sha256( prev_hash || tenantId || seq || eventType || createdAtIso || canonicalJSON(payload) )
 *
 * The chain is per-tenant; `seq` is monotonic per tenant. The DB trigger
 * `audit_immutable()` blocks UPDATE and DELETE on the AuditEvent table, so
 * once written, an event can only be neutralised by writing a *new* event.
 *
 * `superDb` is used deliberately — the trigger and the chain are the
 * integrity guarantees, not the RLS policy. Tenant scoping is still enforced
 * by `tenantId` on every row and on every read query.
 */
export async function writeAuditEvent(input: WriteAuditInput) {
  const created = await superDb.$transaction(async (tx) => {
    const last = await tx.auditEvent.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { seq: "desc" },
      select: { seq: true, hash: true },
    });

    const seq = last ? last.seq + 1n : 1n;
    const prevHash = last?.hash ?? genesisHash(input.tenantId);
    const createdAt = new Date();

    const canonicalPayload = canonicalJson(input.payload);
    const hashInput = [
      prevHash,
      input.tenantId,
      seq.toString(),
      input.eventType,
      createdAt.toISOString(),
      canonicalPayload,
    ].join("\n");
    const hash = sha256(hashInput);

    return tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        seq,
        eventType: input.eventType,
        actorMembershipId: input.actorMembershipId ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: input.payload,
        prevHash,
        hash,
        createdAt,
      },
    });
  });

  // Outbound webhook fan-out (post-PRD hardening item 14). Runs AFTER the
  // audit row commits — a failure here cannot roll back the chain (the
  // commit already happened). enqueueWebhooks has its own try/catch +
  // reportError so an exception here can't bubble. We await it (rather
  // than fire-and-forget) so a transient enqueue failure surfaces in the
  // request log and so tests can observe completion deterministically.
  // For tenants with no subscriptions the cost is one indexed findMany
  // returning []; ~1ms.
  //
  // Webhook-self event types are intentionally excluded so a misbehaving
  // receiver can't recursively flood its own subscription with delivery
  // outcomes.
  if (!WEBHOOK_SELF_EVENT_TYPES.has(input.eventType)) {
    await enqueueWebhooks({
      tenantId: input.tenantId,
      eventType: input.eventType,
      auditEventId: created.id,
      payload: {
        id: created.id,
        tenantSlug: "", // resolved by enqueueWebhooks lazily, only when it has matching subs
        eventType: created.eventType,
        occurredAt: created.createdAt.toISOString(),
        subjectType: created.subjectType,
        subjectId: created.subjectId,
        actorMembershipId: created.actorMembershipId,
        data: created.payload as Prisma.JsonValue,
      },
    });
  }

  return created;
}

function genesisHash(tenantId: string) {
  return sha256(`${SEED}|${tenantId}|genesis`);
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable JSON for hashing: keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Filtered, paginated read of a tenant's audit chain. Used by the
 * /[tenantSlug]/admin/audit review UI (post-PRD hardening item 20). The
 * chain can be huge — items 11–19 alone write dozens of event types — so the
 * default page surface is 50 events with keyset pagination on `seq DESC`.
 *
 * `superDb` mirrors the rest of this module's reads: integrity comes from the
 * append-only trigger + the per-row `tenantId` filter, not from RLS. The
 * caller is expected to enforce RBAC (`audit:read`) before invoking.
 */
export type AuditListFilters = {
  eventTypes?: AuditEventType[];
  actorMembershipId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  since?: Date | null;
  /** Exclusive upper bound — calendar-day friendly (`until = next day 00:00`). */
  until?: Date | null;
};

export type AuditListInput = {
  tenantId: string;
  filters?: AuditListFilters;
  /** Cursor — return only rows with `seq < before`. First page omits. */
  before?: bigint | null;
  /** Page size, clamped to [1, 200]. Default 50. */
  limit?: number;
};

export type AuditListEvent = {
  id: string;
  seq: bigint;
  eventType: AuditEventType;
  actorMembershipId: string | null;
  actor: { user: { email: string; name: string | null } } | null;
  subjectType: string;
  subjectId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  hash: string;
  prevHash: string;
};

export type AuditListResult = {
  events: AuditListEvent[];
  /** String-encoded `seq` of the last row returned; null when no further pages. */
  nextCursor: string | null;
};

const AUDIT_LIST_DEFAULT_LIMIT = 50;
const AUDIT_LIST_MAX_LIMIT = 200;

export async function listAuditEvents(input: AuditListInput): Promise<AuditListResult> {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? AUDIT_LIST_DEFAULT_LIMIT), 1),
    AUDIT_LIST_MAX_LIMIT,
  );
  const f = input.filters ?? {};
  const where: Prisma.AuditEventWhereInput = { tenantId: input.tenantId };

  if (f.eventTypes && f.eventTypes.length > 0) where.eventType = { in: f.eventTypes };
  if (f.actorMembershipId) where.actorMembershipId = f.actorMembershipId;
  if (f.subjectType) where.subjectType = f.subjectType;
  if (f.subjectId) where.subjectId = f.subjectId;
  if (f.since || f.until) {
    where.createdAt = {
      ...(f.since ? { gte: f.since } : {}),
      ...(f.until ? { lt: f.until } : {}),
    };
  }
  if (input.before != null) where.seq = { lt: input.before };

  // Take one extra row to determine whether a next page exists without
  // running a separate count query (the chain can be very long).
  const rows = await superDb.auditEvent.findMany({
    where,
    orderBy: { seq: "desc" },
    take: limit + 1,
    include: {
      actor: { include: { user: { select: { email: true, name: true } } } },
    },
  });

  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && events.length > 0 ? events[events.length - 1].seq.toString() : null;

  return {
    events: events.map((e) => ({
      id: e.id,
      seq: e.seq,
      eventType: e.eventType,
      actorMembershipId: e.actorMembershipId,
      actor: e.actor
        ? { user: { email: e.actor.user.email, name: e.actor.user.name } }
        : null,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      payload: e.payload as Prisma.JsonValue,
      createdAt: e.createdAt,
      hash: e.hash,
      prevHash: e.prevHash,
    })),
    nextCursor,
  };
}

/**
 * Resolve `actor` filter token to a membership id within the tenant. Accepts
 * either a raw membership id or an email — the audit page treats both as
 * valid so a reviewer can paste either. Returns `null` if no membership
 * matches (the page renders an empty result rather than a hard error).
 */
export async function resolveAuditActor(
  tenantId: string,
  token: string,
): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const membership = await superDb.membership.findFirst({
      where: { tenantId, user: { email: trimmed.toLowerCase() } },
      select: { id: true },
    });
    return membership?.id ?? null;
  }
  const membership = await superDb.membership.findFirst({
    where: { tenantId, id: trimmed },
    select: { id: true },
  });
  return membership?.id ?? null;
}

/**
 * Walk a tenant's audit chain and verify every hash. Used by
 * `scripts/verify-audit-chain.ts` and the export endpoint.
 */
export async function verifyAuditChain(tenantId: string): Promise<{ ok: boolean; failedAt?: bigint }> {
  const events = await superDb.auditEvent.findMany({
    where: { tenantId },
    orderBy: { seq: "asc" },
  });
  let prev = genesisHash(tenantId);
  for (const e of events) {
    if (e.prevHash !== prev) return { ok: false, failedAt: e.seq };
    const expected = sha256(
      [prev, tenantId, e.seq.toString(), e.eventType, e.createdAt.toISOString(), canonicalJson(e.payload)].join("\n"),
    );
    if (expected !== e.hash) return { ok: false, failedAt: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}
