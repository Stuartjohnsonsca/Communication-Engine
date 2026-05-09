import { NextResponse } from "next/server";
import { runLifecycleSweep } from "@/lib/lifecycle";

/**
 * PRD §14.3 lifecycle sweep. Idempotent — only acts on rows whose grace
 * window has expired. Run on a schedule (Railway cron or any external
 * scheduler) using a shared secret in the `Authorization` header:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/lifecycle-sweep
 *
 * Returns counts so the scheduler log shows what moved.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const result = await runLifecycleSweep();
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
