import type { Prisma } from "@prisma/client";
import { promises as dnsPromises } from "node:dns";
import { superDb, superDbWith } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { decryptJson } from "@/lib/channels/crypto";
import { reportError, log } from "@/lib/observability";
import { signBody, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER } from "./signing";
import { assertEgressAllowed, readBodyWithCap } from "./ssrf";

type DnsLookup = (hostname: string) => Promise<{ address: string; family: number }>;

/**
 * Cron-driven delivery worker. Drains PENDING WebhookDelivery rows whose
 * `scheduledFor` has passed, POSTs the payload to the receiver with an
 * HMAC-SHA256 signature, and on failure schedules a retry with exponential
 * backoff. After `maxAttempts` we flip the row to DEAD_LETTERED.
 *
 * Concurrency safety: the worker locks rows it picks up by flipping their
 * status to IN_FLIGHT inside a single conditional UPDATE — a second worker
 * (or a duplicate cron invocation) cannot grab the same row. We unlock by
 * flipping to PENDING / DELIVERED / DEAD_LETTERED at the end of the
 * attempt. If the worker process dies mid-attempt, the stale IN_FLIGHT row
 * is reclaimed on the next sweep via the timeout heuristic in
 * `reclaimStaleInFlight`.
 *
 * Cron should call `runWebhookDeliveryBatch()` every minute or so.
 */

const DEFAULT_BACKOFF_MS = [
  60_000,      // 1 minute
  5 * 60_000,  // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 60 * 60_000,  // 2 hours
  12 * 60 * 60_000, // 12 hours
];

const REQUEST_TIMEOUT_MS = 15_000;
/** Storage cap for `lastResponseBody` (after truncation). */
const RESPONSE_BODY_STORE_CAP_CHARS = 1024;
/**
 * Hard cap on bytes read from a receiver's response body. The previous
 * implementation called `await res.text()` and then sliced — meaning a
 * hostile receiver could return a multi-GB body and OOM the worker
 * before any truncation happened. We now stream-and-cap at 64KB.
 */
const RESPONSE_BODY_READ_CAP_BYTES = 64 * 1024;
const IN_FLIGHT_STALE_MS = 5 * 60_000;

export type DeliverBatchResult = {
  picked: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  reclaimed: number;
};

export async function runWebhookDeliveryBatch(opts: {
  /** Max deliveries to attempt in this batch. Defaults to 50. */
  maxBatch?: number;
  /** Test hook: override fetch. */
  fetchImpl?: typeof fetch;
  /** Test hook: override DNS lookup for SSRF check. */
  lookupImpl?: DnsLookup;
  /** Test hook: override clock. */
  now?: () => Date;
} = {}): Promise<DeliverBatchResult> {
  const maxBatch = opts.maxBatch ?? 50;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookupImpl =
    opts.lookupImpl ??
    (async (h: string) => {
      const r = await dnsPromises.lookup(h);
      return { address: r.address, family: r.family };
    });
  const now = opts.now ?? (() => new Date());

  const reclaimed = await reclaimStaleInFlight(now());

  // Pick due rows. We over-select by 5x and then atomically lock each
  // one — under concurrent workers some rows will already be IN_FLIGHT
  // and the conditional UPDATE will report 0 affected rows.
  const candidates = await superDb.webhookDelivery.findMany({
    where: {
      status: "PENDING",
      scheduledFor: { lte: now() },
    },
    orderBy: { scheduledFor: "asc" },
    take: maxBatch,
    select: { id: true },
  });

  const result: DeliverBatchResult = {
    picked: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    reclaimed,
  };

  for (const c of candidates) {
    const locked = await lockDelivery(c.id, now());
    if (!locked) continue;
    result.picked += 1;
    const outcome = await attemptDelivery(locked, { fetchImpl, lookupImpl, now });
    if (outcome === "delivered") result.delivered += 1;
    else if (outcome === "retried") result.retried += 1;
    else result.deadLettered += 1;
  }

  return result;
}

type LockedDelivery = Awaited<ReturnType<typeof loadFullDelivery>>;

async function loadFullDelivery(id: string) {
  return superDb.webhookDelivery.findUnique({
    where: { id },
    include: {
      subscription: true,
    },
  });
}

async function lockDelivery(id: string, asOf: Date): Promise<NonNullable<LockedDelivery> | null> {
  // Atomic transition PENDING → IN_FLIGHT. The updateMany returns the
  // count of affected rows; if another worker beat us to this row,
  // count = 0 and we skip.
  const update = await superDb.webhookDelivery.updateMany({
    where: { id, status: "PENDING", scheduledFor: { lte: asOf } },
    data: { status: "IN_FLIGHT", updatedAt: asOf },
  });
  if (update.count === 0) return null;
  const full = await loadFullDelivery(id);
  if (!full) return null;
  return full;
}

async function attemptDelivery(
  row: NonNullable<LockedDelivery>,
  ctx: { fetchImpl: typeof fetch; lookupImpl: DnsLookup; now: () => Date },
): Promise<"delivered" | "retried" | "dead-lettered"> {
  const subscription = row.subscription;
  if (!subscription) {
    await finaliseDeadLetter(row.id, row.attempt + 1, "subscription missing", null, null, row.tenantId, row.subscriptionId);
    return "dead-lettered";
  }
  if (!subscription.enabled) {
    // Subscription was disabled while this delivery was queued. Treat as
    // dead-lettered immediately — no audit churn from auto-disabled
    // subscriptions silently catching up.
    await finaliseDeadLetter(row.id, row.attempt + 1, "subscription disabled", null, null, row.tenantId, subscription.id);
    return "dead-lettered";
  }
  const secret = decryptJson<string>(subscription.secretEncrypted);
  const body = JSON.stringify(row.payload);
  const attempt = row.attempt + 1;

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let ok = false;

  // SSRF defence at delivery time. The config-time URL check refuses
  // obvious mistakes; a hostile receiver can still DNS-rebind to point
  // at internal infra between then and now. Re-resolve and check on
  // every attempt.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(subscription.url);
  } catch {
    errorMessage = "subscription URL is not parseable";
    log.warn("webhook delivery blocked (URL parse)", {
      deliveryId: row.id,
      subscriptionId: subscription.id,
      tenantId: row.tenantId,
      url: subscription.url,
    });
    // Unparseable URL is permanent — dead-letter immediately rather than
    // retrying. A retry can't make a broken URL parseable.
    await finaliseDeadLetter(
      row.id,
      attempt,
      errorMessage,
      null,
      null,
      row.tenantId,
      subscription.id,
    );
    await maybeAutoDisable(subscription.id, row.tenantId);
    return "dead-lettered";
  }

  const egress = await assertEgressAllowed(parsedUrl.hostname, { lookup: ctx.lookupImpl });
  if (!egress.allowed) {
    errorMessage = `egress blocked: ${egress.reason}`;
    log.warn("webhook delivery blocked (SSRF)", {
      deliveryId: row.id,
      subscriptionId: subscription.id,
      tenantId: row.tenantId,
      hostname: parsedUrl.hostname,
      reason: egress.reason,
    });
    // Skip the fetch — fall through to the failure/retry path with no
    // network call. Repeated SSRF blocks count toward auto-disable so a
    // misconfigured / hostile subscription doesn't keep generating audit
    // chatter forever.
  } else {
    try {
      const signed = signBody({ secret, body, timestampSeconds: Math.floor(ctx.now().getTime() / 1000) });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await ctx.fetchImpl(subscription.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Acumon-Webhook/1.0",
            [SIGNATURE_HEADER]: signed,
            [EVENT_HEADER]: row.eventType,
            [DELIVERY_HEADER]: row.id,
          },
          body,
          signal: controller.signal,
        });
        statusCode = res.status;
        const read = await readBodyWithCap(res, RESPONSE_BODY_READ_CAP_BYTES);
        responseBody = read.text
          ? read.text.slice(0, RESPONSE_BODY_STORE_CAP_CHARS)
          : null;
        ok = res.status >= 200 && res.status < 300;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      log.warn("webhook delivery network error", {
        deliveryId: row.id,
        subscriptionId: subscription.id,
        tenantId: row.tenantId,
        err: errorMessage,
      });
    }
  }

  if (ok) {
    await finaliseDelivered(row.id, attempt, statusCode, responseBody, row.tenantId, subscription.id, row.eventType);
    return "delivered";
  }

  if (attempt >= row.maxAttempts) {
    await finaliseDeadLetter(
      row.id,
      attempt,
      errorMessage ?? `receiver returned ${statusCode}`,
      statusCode,
      responseBody,
      row.tenantId,
      subscription.id,
    );
    // Auto-disable on consecutive dead-letters.
    await maybeAutoDisable(subscription.id, row.tenantId);
    return "dead-lettered";
  }

  // Schedule the next attempt and unlock.
  const backoffMs = DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)];
  await superDb.webhookDelivery.update({
    where: { id: row.id },
    data: {
      attempt,
      status: "PENDING",
      scheduledFor: new Date(ctx.now().getTime() + backoffMs),
      lastStatusCode: statusCode,
      lastResponseBody: responseBody,
      lastError: errorMessage,
    },
  });
  return "retried";
}

async function finaliseDelivered(
  deliveryId: string,
  attempt: number,
  statusCode: number | null,
  responseBody: string | null,
  tenantId: string,
  subscriptionId: string,
  eventType: string,
) {
  const now = new Date();
  await superDb.$transaction([
    superDb.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempt,
        status: "DELIVERED",
        lastStatusCode: statusCode,
        lastResponseBody: responseBody,
        lastError: null,
        completedAt: now,
      },
    }),
    superDb.webhookSubscription.update({
      where: { id: subscriptionId },
      data: {
        consecutiveFailures: 0,
        lastDeliveredAt: now,
        lastStatusCode: statusCode,
      },
    }),
  ]);
  await writeAuditEvent({
    tenantId,
    eventType: "WEBHOOK_DELIVERED",
    actorMembershipId: null,
    subjectType: "WebhookDelivery",
    subjectId: deliveryId,
    payload: {
      subscriptionId,
      eventType,
      attempt,
      statusCode,
    },
  });
}

async function finaliseDeadLetter(
  deliveryId: string,
  attempt: number,
  errorMessage: string,
  statusCode: number | null,
  responseBody: string | null,
  tenantId: string,
  subscriptionId: string,
) {
  const now = new Date();
  await superDb.$transaction([
    superDb.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempt,
        status: "DEAD_LETTERED",
        lastStatusCode: statusCode,
        lastResponseBody: responseBody,
        lastError: errorMessage,
        completedAt: now,
      },
    }),
    superDb.webhookSubscription.update({
      where: { id: subscriptionId },
      data: {
        consecutiveFailures: { increment: 1 },
        lastFailureAt: now,
        lastStatusCode: statusCode,
      },
    }),
  ]);
  await writeAuditEvent({
    tenantId,
    eventType: "WEBHOOK_DEAD_LETTERED",
    actorMembershipId: null,
    subjectType: "WebhookDelivery",
    subjectId: deliveryId,
    payload: {
      subscriptionId,
      statusCode,
      error: errorMessage.slice(0, 256),
      attempt,
    },
  });
}

async function maybeAutoDisable(subscriptionId: string, tenantId: string) {
  const row = await superDb.webhookSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, enabled: true, consecutiveFailures: true, autoDisableThreshold: true },
  });
  if (!row || !row.enabled) return;
  if (row.consecutiveFailures < row.autoDisableThreshold) return;
  await superDb.webhookSubscription.update({
    where: { id: subscriptionId },
    data: { enabled: false },
  });
  await writeAuditEvent({
    tenantId,
    eventType: "WEBHOOK_SUBSCRIPTION_AUTO_DISABLED",
    actorMembershipId: null,
    subjectType: "WebhookSubscription",
    subjectId: subscriptionId,
    payload: {
      consecutiveFailures: row.consecutiveFailures,
      autoDisableThreshold: row.autoDisableThreshold,
    },
  });
}

/**
 * Reclaim rows that have been IN_FLIGHT for longer than the timeout — a
 * worker probably died mid-attempt. The row is flipped back to PENDING
 * without bumping the attempt counter so the receiver isn't double-charged
 * an attempt for our crash.
 */
async function reclaimStaleInFlight(asOf: Date): Promise<number> {
  const cutoff = new Date(asOf.getTime() - IN_FLIGHT_STALE_MS);
  const result = await superDb.webhookDelivery.updateMany({
    where: {
      status: "IN_FLIGHT",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "PENDING",
    },
  });
  return result.count;
}

/**
 * House-keeping: prune DELIVERED rows older than `keepDays` (default 30) +
 * DEAD_LETTERED rows older than `keepDays` (default 90) so the delivery
 * table doesn't grow forever. Called from the lifecycle-sweep cron.
 */
export async function reapOldDeliveries(
  opts: { deliveredKeepDays?: number; deadLetteredKeepDays?: number; statementTimeoutMs?: number } = {},
): Promise<{ deleted: number }> {
  const now = Date.now();
  const deliveredCutoff = new Date(now - (opts.deliveredKeepDays ?? 30) * 24 * 60 * 60_000);
  const deadCutoff = new Date(now - (opts.deadLetteredKeepDays ?? 90) * 24 * 60 * 60_000);
  // Bounded statement_timeout — the cumulative deleteMany over `status +
  // completedAt` is the largest sweep this module does and the cron is
  // the only path that touches it; a missing index or bloated stats can
  // turn it into a long scan. 60s default (10x the typical complete
  // time on a healthy index).
  return superDbWith({ statementTimeoutMs: opts.statementTimeoutMs }, async (tx) => {
    const result = await tx.webhookDelivery.deleteMany({
      where: {
        OR: [
          { status: "DELIVERED", completedAt: { lt: deliveredCutoff } },
          { status: "DEAD_LETTERED", completedAt: { lt: deadCutoff } },
        ],
      },
    });
    return { deleted: result.count };
  });
}
