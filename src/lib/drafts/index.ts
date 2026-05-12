/**
 * Item 50 — continuous-background drafting from ingested inbound.
 *
 * Two entry points:
 *   - `produceDraftFromInbound`: factor of the `/api/ai/draft` POST
 *     handler, callable from the cron sweep or any future
 *     inline-on-ingest path. Idempotent on `IngestedMessage.id`.
 *   - `runAutoDraftSweep`: the cron-driven scan that picks up
 *     un-drafted inbound from the last 24h and produces drafts for
 *     each, bounded per tenant per pass.
 *
 * The drafting agent itself (`@/lib/ai/agents/draftAgent`) is unchanged:
 * the cadence rules (acknowledgment vs substantive, time windows like
 * "acknowledge within 30 minutes, respond within 24 hours") come from
 * the firm's FCG and are read by the agent.
 */
export { produceDraftFromInbound } from "./produce-from-inbound";
export type { ProduceFromInboundResult } from "./produce-from-inbound";
export { runAutoDraftSweep } from "./auto-sweep";
export type { AutoDraftSweepResult } from "./auto-sweep";
