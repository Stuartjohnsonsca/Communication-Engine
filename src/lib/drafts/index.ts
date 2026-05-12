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
export { produceDraftFromInbound, QUARANTINE_THRESHOLD } from "./produce-from-inbound";
export type { ProduceFromInboundResult } from "./produce-from-inbound";
export {
  runAutoDraftSweep,
  MAX_BACKLOG_WINDOW_HOURS,
  MAX_PER_TENANT_PER_PASS_CEILING,
} from "./auto-sweep";
export type { AutoDraftSweepResult } from "./auto-sweep";
export { runAutoDraftBackfill, BACKFILL_DAYS_BOUNDS } from "./backfill";
export type { BackfillInput, BackfillResult } from "./backfill";
export { runDraftStaleSweep } from "./stale-sweep";
export type { DraftStaleSweepResult } from "./stale-sweep";
export { computeDraftRollup } from "./rollup";
export type { DraftRollup, DraftRollupWindow, DraftSource } from "./rollup";
export { formatDraftsRollupAsCsv, DRAFTS_ROLLUP_CSV_HEADER } from "./rollup-csv";
export {
  classifyDraft,
  bucketDrafts,
  formatDeadlineRelative,
  isTerminalStatus,
  DUE_SOON_HORIZON_HOURS,
  RECENTLY_CLOSED_HORIZON_DAYS,
} from "./triage";
export type { TriageBucket, TriageDraft } from "./triage";
