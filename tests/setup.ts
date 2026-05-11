/**
 * Per-worker Vitest setup.
 *
 * Disables the post-PRD item 47 cron advisory lock by default for the
 * test suite. Tests that exercise the lock explicitly (see
 * `cron-concurrency.test.ts`) unset this env var inside their describe
 * blocks. Without this, two parallel test files that both call
 * `withCronHeartbeat(...)` could deadlock against each other on shared
 * cron names; the existing `cron-health.test.ts` predates the lock and
 * relies on uncontended acquisition.
 */
process.env.CRON_CONCURRENCY_LOCK = "off";

export {};
