import { NextResponse } from "next/server";
import { CronSkippedError } from "./lock";

/**
 * Wrap the result of `withCronHeartbeat(...)` into a JSON Response.
 *
 * Two response shapes:
 *   - Success: `{ ok: true, ...result }` (the cron's own return value
 *     is spread into the top-level JSON, matching the pre-item-47
 *     behaviour every cron route established).
 *   - Skipped (item 47): `{ ok: true, skipped: "concurrent", cronName }`
 *     — the workload didn't run because another invocation held the
 *     advisory lock. Distinct from a failure: the scheduler should
 *     see status 200 + a `skipped` field rather than a 5xx alert.
 *
 * Any other thrown error is rethrown for the route's outer handler
 * (Next.js wraps it into a 500 + observability picks it up via
 * `instrumentation.ts`).
 */
export async function cronJson<T extends Record<string, unknown>>(
  run: () => Promise<T>,
): Promise<NextResponse> {
  try {
    const result = await run();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof CronSkippedError) {
      return NextResponse.json(
        { ok: true, skipped: "concurrent", cronName: err.cronName },
        { status: 200 },
      );
    }
    throw err;
  }
}
