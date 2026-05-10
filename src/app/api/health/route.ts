import { NextResponse } from "next/server";
import { superDb } from "@/lib/db";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";

export async function GET(req: Request) {
  // Public, scrapable. Cap per-IP so a single source can't pin the DB
  // ping on this surface.
  const rl = await rateLimitByIp(req, "health", 60, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  try {
    await superDb.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      now: new Date().toISOString(),
      service: "communication-engine",
      version: "0.1.0",
    });
  } catch (e) {
    return NextResponse.json(
      { status: "error", error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
