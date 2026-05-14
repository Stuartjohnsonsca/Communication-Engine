/**
 * Registered platform crons + their expected schedule interval (minutes).
 *
 * Hardcoded — these are platform-wide schedules controlled by Railway cron
 * configuration. If the Railway cron cadence changes, update this file
 * alongside the schedule.
 *
 * `expectedIntervalMinutes` informs stall detection: a cron is flagged as
 * stalled when `lastSuccessAt < now - 2 × interval`. The 2× margin absorbs
 * normal jitter (a cron whose interval is "every 1 minute" can legitimately
 * be 90s late on a hot host).
 *
 * Adding a new cron to the platform:
 *   1. Add the entry here.
 *   2. Wrap its handler with `withCronHeartbeat(name, async () => ...)`.
 *   3. The health-check worker picks it up automatically on its next pass.
 */
export type RegisteredCron = {
  cronName: string;
  expectedIntervalMinutes: number;
  /// One-line description for the /admin/health page.
  description: string;
};

export const REGISTERED_CRONS: RegisteredCron[] = [
  {
    cronName: "lifecycle-sweep",
    expectedIntervalMinutes: 24 * 60,
    description:
      "PRD §14.3 lifecycle sweep — anonymisation grace, TIA expiry, session timeout, API-key auto-revoke, rate-limit reaper, webhook delivery reaper.",
  },
  {
    cronName: "billing-close",
    expectedIntervalMinutes: 24 * 60,
    description:
      "PRD §15.1–§15.2 monthly billing period close. Idempotent — only acts on the last day of the month.",
  },
  {
    cronName: "termination",
    expectedIntervalMinutes: 24 * 60,
    description:
      "PRD §14.4 termination lifecycle — generates export packages, runs hard-deletion sweep after grace window.",
  },
  {
    cronName: "digest",
    expectedIntervalMinutes: 7 * 24 * 60,
    description:
      "Backlog item 6 — weekly notification digest. Dedupes per ISO week so a flaky retry within the week is a no-op.",
  },
  {
    cronName: "webhooks-deliver",
    expectedIntervalMinutes: 1,
    description:
      "Backlog item 14 — outbound webhook delivery worker. Drains PENDING WebhookDelivery rows with exponential-backoff retry.",
  },
  {
    cronName: "health-check",
    expectedIntervalMinutes: 15,
    description:
      "This worker — periodically evaluates every other cron's heartbeat and emits CRON_STALLED audit + notifications.",
  },
  {
    cronName: "audit-verify",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 23 — daily background verification of every tenant's audit chain. Emits AUDIT_CHAIN_TAMPERED audit + critical notification on hash mismatch.",
  },
  {
    cronName: "auto-draft",
    expectedIntervalMinutes: 5,
    description:
      "Item 50 — continuous-background draft producer. Scans IngestedMessage IN rows without a linked Draft and runs the drafting agent against each. FCG cadence (acknowledgment vs substantive) is honoured by the agent itself; this worker just feeds it the un-drafted inbound.",
  },
  {
    cronName: "channel-auth-expiry",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 53 — daily pre-emptive ChannelAuth expiry warning. Scans ACTIVE auths with expiresAt inside 7d and fires a channel_auth_expiring notification at 7d + 1d thresholds, deduped per (auth, threshold) via the dispatch table. Without this, an expiring OAuth token would silently stop ingest with no operator-visible breadcrumb.",
  },
  {
    cronName: "draft-stale",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 54 — daily stale-draft sweeper. Scans Drafts whose fcgWindowDeadline has passed without send/discard and fires a draft_stale notification to the owning Membership. One warning per draft (dispatch-table dedupe). Surfaces FCG response-window breach so the firm doesn't silently miss its own commitment.",
  },
  {
    cronName: "adherence-monitor",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 71 — daily firm-adherence escalation. Computes each tenant's 7d FCG-window adherence rate via the /admin/drafts rollup and fires a mandatory firm_adherence_below_threshold notification to every FIRM_ADMIN when the rate is below ADHERENCE_THRESHOLD with at least MIN_DEADLINED_SENDS deadlined sends. Deduped per ISO week so a chronically-poor tenant gets one alert per week, not one per cron tick.",
  },
  {
    cronName: "sentiment-stale",
    expectedIntervalMinutes: 60,
    description:
      "Item 77 — hourly stale-sentiment-escalation sweeper. Re-notifies the original PRD §9.3 escalation audience when a signal has been unacked for STALE_THRESHOLD_HOURS (4h). One nudge per signal ever — audit chain is the dedupe gate. Bounds the second-chance signal to within an hour of the 4h stale mark.",
  },
  {
    cronName: "sentiment-firm-ack-monitor",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 84 — daily firm-wide sentiment ack-rate escalation. Sister to adherence-monitor (item 71) on the sentiment side. Computes each tenant's 7d sentiment ack rate via computeSentimentMetrics (same numbers as /sentiment) and fires a mandatory firm_sentiment_ack_rate_below_threshold notification to every FIRM_ADMIN when the rate is below ACK_RATE_THRESHOLD with at least MIN_ESCALATED_FOR_ALERT escalations. Deduped per ISO week.",
  },
  {
    cronName: "adherence-firm-ack-monitor",
    expectedIntervalMinutes: 24 * 60,
    description:
      "Item 95 — daily firm-wide adherence-escalation ack-rate alert. Adherence-pillar analog of sentiment-firm-ack-monitor (item 84). Distinct from adherence-monitor (item 71) which measures FCG-WINDOW adherence: this measures ack-rate on already-fired below-threshold escalations. Computes each tenant's 7d adherence ack rate via computeAdherenceMetrics (same numbers as /adherence/escalations) and fires a mandatory firm_adherence_ack_rate_below_threshold notification to every FIRM_ADMIN when the rate is below ACK_RATE_THRESHOLD with at least MIN_ESCALATED_FOR_ALERT escalations. Deduped per ISO week, distinct dedupe namespace from item 71 so both can fire independently in the same week.",
  },
];

export function registeredCron(cronName: string): RegisteredCron | undefined {
  return REGISTERED_CRONS.find((c) => c.cronName === cronName);
}
