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
