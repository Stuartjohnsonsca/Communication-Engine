import type { WebhookSubscription, Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { encryptJson, decryptJson } from "@/lib/channels/crypto";
import { generateSecret } from "./signing";
import { isBlockedHostname } from "./ssrf";

/**
 * CRUD for WebhookSubscription. RLS is enforced when reads happen via
 * `tenantDb`; this module additionally accepts an explicit `tenantId` on
 * every call so callers cannot accidentally cross tenants. Mutations are
 * audited on the tenant chain.
 *
 * Secret handling: the plaintext is generated server-side, returned ONCE on
 * creation, and stored encrypted via `encryptJson` (AES-256-GCM with
 * `ENCRYPTION_KEY`). Subsequent reads only return the encrypted blob; the
 * dispatcher decrypts it just-in-time per delivery via `getSubscriptionSecret`.
 */

export type CreateSubscriptionInput = {
  tenantId: string;
  actorMembershipId: string;
  name: string;
  url: string;
  /** Either ["*"] (all events) or specific AuditEventType strings. */
  eventTypes: string[];
};

export type CreateSubscriptionResult = {
  subscription: PublicSubscription;
  /** Plaintext secret — shown to the user once, never recoverable. */
  secret: string;
};

export type PublicSubscription = Omit<
  WebhookSubscription,
  "secretEncrypted" | "secretEncryptedPrev"
>;

export class WebhookValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

const MAX_NAME = 120;
const MAX_EVENTS = 200;
// In production we refuse to enqueue against http://, loopback, or anything
// that resembles internal infra (file://, ssh://, etc.). In dev/tests we
// allow http to keep the integration test loop simple.
const ALLOW_HTTP = process.env.NODE_ENV !== "production";

export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookValidationError("URL is not parseable");
  }
  if (parsed.protocol !== "https:" && !(ALLOW_HTTP && parsed.protocol === "http:")) {
    throw new WebhookValidationError(
      ALLOW_HTTP ? "URL must be http:// or https://" : "URL must be https://",
    );
  }
  // Hostname-level block: rejects localhost, *.localhost, *.local,
  // *.internal, cloud-metadata literals, and bare IP literals that fall
  // in any private/loopback/link-local/CGNAT/benchmark/multicast range
  // (v4 + v6). Defence in depth — delivery-time `assertEgressAllowed`
  // also re-checks via DNS to close the DNS-rebinding window.
  //
  // Allowed in dev/test so the integration suite can keep posting at
  // 127.0.0.1; in prod this is the wall that catches the typo case
  // (copy-pasted localhost URL) before it ever reaches a delivery
  // attempt.
  if (process.env.NODE_ENV === "production" && isBlockedHostname(parsed.hostname)) {
    throw new WebhookValidationError("URL must not target a private/loopback host");
  }
  if (parsed.username || parsed.password) {
    throw new WebhookValidationError("URL must not embed credentials");
  }
}

export function normaliseEventTypes(input: string[]): string[] {
  if (!Array.isArray(input)) {
    throw new WebhookValidationError("eventTypes must be an array");
  }
  if (input.length === 0) {
    throw new WebhookValidationError("eventTypes must include at least one entry");
  }
  if (input.length > MAX_EVENTS) {
    throw new WebhookValidationError(`eventTypes must include at most ${MAX_EVENTS} entries`);
  }
  // De-duplicate; preserve original order so the admin UI shows what the
  // creator entered.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new WebhookValidationError("eventTypes entries must be strings");
    }
    const v = raw.trim();
    if (!v) continue;
    if (v !== "*" && !/^[A-Z][A-Z0-9_]+$/.test(v)) {
      throw new WebhookValidationError(`Invalid event type: ${v}`);
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  if (out.length === 0) {
    throw new WebhookValidationError("eventTypes must include at least one entry");
  }
  // ["*"] is the canonical wildcard. If both "*" and explicit entries are
  // given, collapse to ["*"] — explicit entries are a no-op alongside it.
  if (out.includes("*")) return ["*"];
  return out;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  const name = (input.name ?? "").trim();
  if (!name) throw new WebhookValidationError("name is required");
  if (name.length > MAX_NAME) {
    throw new WebhookValidationError(`name must be ${MAX_NAME} characters or fewer`);
  }
  const url = (input.url ?? "").trim();
  validateUrl(url);
  const eventTypes = normaliseEventTypes(input.eventTypes ?? []);

  const secret = generateSecret();
  const created = await superDb.webhookSubscription.create({
    data: {
      tenantId: input.tenantId,
      name,
      url,
      secretEncrypted: encryptJson(secret),
      eventTypes,
      createdByMembershipId: input.actorMembershipId,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "WEBHOOK_SUBSCRIPTION_CREATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "WebhookSubscription",
    subjectId: created.id,
    payload: {
      name: created.name,
      url: created.url,
      eventTypes: created.eventTypes,
    },
  });

  return {
    subscription: stripSecret(created),
    secret,
  };
}

export type UpdateSubscriptionInput = {
  tenantId: string;
  subscriptionId: string;
  actorMembershipId: string;
  patch: {
    name?: string;
    url?: string;
    eventTypes?: string[];
    enabled?: boolean;
  };
};

export async function updateSubscription(input: UpdateSubscriptionInput): Promise<PublicSubscription> {
  const existing = await assertOwnedByTenant(input.tenantId, input.subscriptionId);
  const patch: Record<string, unknown> = {};
  if (input.patch.name !== undefined) {
    const v = input.patch.name.trim();
    if (!v) throw new WebhookValidationError("name is required");
    if (v.length > MAX_NAME) {
      throw new WebhookValidationError(`name must be ${MAX_NAME} characters or fewer`);
    }
    patch.name = v;
  }
  if (input.patch.url !== undefined) {
    const v = input.patch.url.trim();
    validateUrl(v);
    patch.url = v;
  }
  if (input.patch.eventTypes !== undefined) {
    patch.eventTypes = normaliseEventTypes(input.patch.eventTypes);
  }
  if (input.patch.enabled !== undefined) {
    patch.enabled = !!input.patch.enabled;
    // Re-enabling after auto-disable resets the failure counter so the next
    // delivery gets a clean slate. Without this, a single subsequent dead-
    // lettered delivery would tip the row back into auto-disabled.
    if (input.patch.enabled === true && existing.enabled === false) {
      patch.consecutiveFailures = 0;
    }
  }
  if (Object.keys(patch).length === 0) {
    return stripSecret(existing);
  }
  const updated = await superDb.webhookSubscription.update({
    where: { id: input.subscriptionId },
    data: patch,
  });
  // Sanitise to a JSON-serialisable shape — Prisma's InputJsonValue type
  // rejects `unknown`. We strip the internal `consecutiveFailures` reset
  // (it isn't user-meaningful) and coerce known fields explicitly.
  const auditPatch: Record<string, unknown> = {};
  if (typeof patch.name === "string") auditPatch.name = patch.name;
  if (typeof patch.url === "string") auditPatch.url = patch.url;
  if (Array.isArray(patch.eventTypes)) auditPatch.eventTypes = patch.eventTypes;
  if (typeof patch.enabled === "boolean") auditPatch.enabled = patch.enabled;
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "WEBHOOK_SUBSCRIPTION_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "WebhookSubscription",
    subjectId: updated.id,
    payload: { patch: auditPatch as Prisma.InputJsonValue },
  });
  return stripSecret(updated);
}

export async function deleteSubscription(input: {
  tenantId: string;
  subscriptionId: string;
  actorMembershipId: string;
}): Promise<void> {
  const existing = await assertOwnedByTenant(input.tenantId, input.subscriptionId);
  await superDb.webhookSubscription.delete({ where: { id: existing.id } });
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "WEBHOOK_SUBSCRIPTION_DELETED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "WebhookSubscription",
    subjectId: existing.id,
    payload: {
      name: existing.name,
      url: existing.url,
    },
  });
}

export async function listSubscriptions(tenantId: string): Promise<PublicSubscription[]> {
  const rows = await superDb.webhookSubscription.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(stripSecret);
}

export async function getSubscription(
  tenantId: string,
  subscriptionId: string,
): Promise<PublicSubscription | null> {
  const row = await superDb.webhookSubscription.findFirst({
    where: { id: subscriptionId, tenantId },
  });
  return row ? stripSecret(row) : null;
}

/**
 * Decrypt and return the plaintext signing secret. Used by the dispatcher
 * (and only the dispatcher) to compute the X-Acumon-Signature header.
 */
export async function getSubscriptionSecret(
  tenantId: string,
  subscriptionId: string,
): Promise<string | null> {
  const row = await superDb.webhookSubscription.findFirst({
    where: { id: subscriptionId, tenantId },
    select: { secretEncrypted: true },
  });
  if (!row) return null;
  return decryptJson<string>(row.secretEncrypted);
}

/**
 * Item 46 — return BOTH the current secret and, when a rotation grace
 * window is in flight, the previous secret. Past `secretPrevRetiresAt`
 * the previous is suppressed even if the column still holds the blob;
 * lifecycle-sweep clears it lazily.
 */
export type SubscriptionSecrets = {
  current: string;
  /// Set only when `secretPrevRetiresAt > now`. The dispatcher signs
  /// with both, in the order [current, previous].
  previous: string | null;
};

export async function getSubscriptionSecrets(
  tenantId: string,
  subscriptionId: string,
  asOf: Date = new Date(),
): Promise<SubscriptionSecrets | null> {
  const row = await superDb.webhookSubscription.findFirst({
    where: { id: subscriptionId, tenantId },
    select: {
      secretEncrypted: true,
      secretEncryptedPrev: true,
      secretPrevRetiresAt: true,
    },
  });
  if (!row) return null;
  const current = decryptJson<string>(row.secretEncrypted);
  const prevActive =
    row.secretEncryptedPrev != null &&
    row.secretPrevRetiresAt != null &&
    row.secretPrevRetiresAt > asOf;
  return {
    current,
    previous: prevActive ? decryptJson<string>(row.secretEncryptedPrev!) : null,
  };
}

export type RotateSecretInput = {
  tenantId: string;
  subscriptionId: string;
  actorMembershipId: string;
  /// Hours the previous secret stays valid. Clamped to [1, 168] (1 hour
  /// to 1 week). Default 24h — enough for receivers to roll their
  /// configured secret without scrambling.
  graceWindowHours?: number;
};

export type RotateSecretResult = {
  subscription: PublicSubscription;
  /// Plaintext NEW secret — shown to the operator once, never recoverable.
  secret: string;
  /// Wall-clock instant after which the previous secret stops being
  /// included in the signature header.
  prevRetiresAt: Date;
};

const ROTATE_GRACE_MIN_HOURS = 1;
const ROTATE_GRACE_MAX_HOURS = 7 * 24;
const ROTATE_GRACE_DEFAULT_HOURS = 24;

/**
 * Generate a fresh signing secret + move the existing one into the
 * "previous" slot with a grace window. The dispatcher signs with both
 * until `prevRetiresAt`, after which only the new secret is used.
 *
 * Plaintext is returned exactly once. The audit event records the
 * grace window + retire timestamp but NEVER the secret material.
 *
 * Idempotency: if a rotation is already in flight (prev still active),
 * calling again replaces the in-flight prev with the current secret and
 * generates yet another new secret. That's a reasonable interpretation
 * of "rotate again" — the new prev becomes the freshly-rotated value
 * and the older prev is discarded. Operators rotating in a panic don't
 * end up with a three-secret window.
 */
export async function rotateSubscriptionSecret(
  input: RotateSecretInput,
): Promise<RotateSecretResult> {
  const existing = await assertOwnedByTenant(input.tenantId, input.subscriptionId);
  const raw = input.graceWindowHours ?? ROTATE_GRACE_DEFAULT_HOURS;
  const hours = Math.max(ROTATE_GRACE_MIN_HOURS, Math.min(ROTATE_GRACE_MAX_HOURS, Math.trunc(raw)));
  const now = new Date();
  const prevRetiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const newSecret = generateSecret();
  const updated = await superDb.webhookSubscription.update({
    where: { id: existing.id },
    data: {
      secretEncrypted: encryptJson(newSecret),
      // The CURRENT secret becomes the previous slot. If a rotation was
      // already in flight, the in-flight prev is discarded — see the
      // function-level note above.
      secretEncryptedPrev: existing.secretEncrypted,
      secretPrevRetiresAt: prevRetiresAt,
    },
  });
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "WEBHOOK_SUBSCRIPTION_SECRET_ROTATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "WebhookSubscription",
    subjectId: existing.id,
    payload: {
      graceWindowHours: hours,
      prevRetiresAt: prevRetiresAt.toISOString(),
    },
  });
  return {
    subscription: stripSecret(updated),
    secret: newSecret,
    prevRetiresAt,
  };
}

/**
 * Lifecycle-sweep helper — clear the previous-secret slot on
 * subscriptions whose grace window has passed. Safe to call without
 * the lifecycle cron: the dispatcher already short-circuits on a
 * retired `secretPrevRetiresAt`, so this is housekeeping only (keeps
 * the encrypted blob out of `pg_dump` after the window).
 */
export async function clearRetiredPreviousSecrets(asOf: Date = new Date()): Promise<{ cleared: number }> {
  const result = await superDb.webhookSubscription.updateMany({
    where: {
      secretEncryptedPrev: { not: null },
      secretPrevRetiresAt: { lt: asOf },
    },
    data: {
      secretEncryptedPrev: null,
      secretPrevRetiresAt: null,
    },
  });
  return { cleared: result.count };
}

async function assertOwnedByTenant(
  tenantId: string,
  subscriptionId: string,
): Promise<WebhookSubscription> {
  const row = await superDb.webhookSubscription.findFirst({
    where: { id: subscriptionId, tenantId },
  });
  if (!row) {
    throw new WebhookValidationError("subscription not found");
  }
  return row;
}

function stripSecret(row: WebhookSubscription): PublicSubscription {
  // Hide BOTH the current and the previous (rotation grace window)
  // encrypted blobs from API surfaces. Even encrypted, exposing them
  // gives an attacker who later finds ENCRYPTION_KEY a free recovery
  // path; the previous-secret column is no different.
  const { secretEncrypted: _omit, secretEncryptedPrev: _omitPrev, ...rest } = row;
  void _omit;
  void _omitPrev;
  return rest;
}
