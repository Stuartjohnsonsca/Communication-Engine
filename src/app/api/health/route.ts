import { NextResponse } from "next/server";
import { superDb } from "@/lib/db";

export async function GET() {
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
