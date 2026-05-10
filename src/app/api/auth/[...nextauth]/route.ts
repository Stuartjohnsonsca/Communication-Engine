import { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { rateLimit, clientIpFromHeaders, tooManyRequestsResponse } from "@/lib/ratelimit";

const { GET: AUTH_GET, POST: AUTH_POST } = handlers;

export const GET = AUTH_GET;

/**
 * Wraps NextAuth's POST handler with two layers of brute-force protection:
 *   1. Per-IP — caps total auth POSTs from one source (sign-in attempts,
 *      callback verifications, sign-out). 30/minute is generous for a real
 *      user, prohibitive for credential-stuffing.
 *   2. Per-email — when the body has an identifier (the email-OTP path),
 *      caps OTP requests + verifies for that email. 6/minute stops a
 *      targeted brute-force against a known address.
 *
 * Both fail OPEN on DB error (rate-limit must never lock everyone out of
 * sign-in). The per-email check only fires when we can find an email in the
 * request body — for path segments NextAuth uses without a body (callback
 * GETs go through AUTH_GET which is unwrapped by design — those are
 * confirmations of an already-issued token).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIpFromHeaders(req.headers);
  const ipResult = await rateLimit({
    identity: { kind: "ip", value: ip },
    scope: "sign-in",
    limit: 30,
    windowSeconds: 60,
  });
  if (!ipResult.allowed) return tooManyRequestsResponse(ipResult, "Too many sign-in attempts. Try again shortly.");

  // Sniff the body for an email so we can apply a per-identifier cap.
  // Clone first so we don't consume the stream NextAuth needs to read.
  let email: string | null = null;
  try {
    const cloned = req.clone();
    const ct = cloned.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await cloned.text();
      const params = new URLSearchParams(text);
      const candidate = params.get("email") ?? params.get("identifier");
      if (candidate && candidate.includes("@") && candidate.length <= 320) {
        email = candidate.trim().toLowerCase();
      }
    } else if (ct.includes("application/json")) {
      const json = (await cloned.json()) as Record<string, unknown>;
      const candidate = json["email"] ?? json["identifier"];
      if (typeof candidate === "string" && candidate.includes("@") && candidate.length <= 320) {
        email = candidate.trim().toLowerCase();
      }
    }
  } catch {
    // Bodyless or malformed — fall through; the IP cap above is still in force.
  }

  if (email) {
    const emailResult = await rateLimit({
      identity: { kind: "auth", value: email },
      scope: "sign-in",
      limit: 6,
      windowSeconds: 60,
    });
    if (!emailResult.allowed) {
      return tooManyRequestsResponse(
        emailResult,
        "Too many sign-in attempts for this address. Try again shortly.",
      );
    }
  }

  return AUTH_POST(req);
}
