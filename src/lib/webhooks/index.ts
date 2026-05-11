/**
 * Outbound webhook delivery (post-PRD hardening item 14).
 *
 * Tenants subscribe an HTTPS receiver to a set of audit-event types and
 * receive a signed POST whenever any matching event lands on their audit
 * chain. Signing is HMAC-SHA256 with a per-subscription secret; the cron
 * worker drains PENDING deliveries with exponential backoff and dead-
 * letters after `maxAttempts`.
 *
 * Boundaries:
 *  - `subscriptions.ts` — CRUD called from the admin UI and tests.
 *  - `dispatch.ts`      — `enqueueWebhooks(...)` called from `writeAuditEvent`
 *                         AFTER the audit row commits.
 *  - `deliver.ts`       — `runWebhookDeliveryBatch(...)` called from
 *                         `/api/cron/webhooks-deliver`.
 *  - `signing.ts`       — HMAC + Stripe-style signature header.
 */
export * from "./signing";
export * from "./subscriptions";
export * from "./dispatch";
export * from "./deliver";
export * from "./test-fire";
export * from "./delivery-stats";
