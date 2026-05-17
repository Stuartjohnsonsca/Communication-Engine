import { reportError } from "@/lib/observability";
import type { SendInput, SendResult } from "./mailer";

/**
 * Microsoft Graph mailer — sends transactional email via the Graph
 * `/users/{from}/sendMail` endpoint using the OAuth client-credentials
 * flow. Alternative to nodemailer + SMTP AUTH for tenants where M365
 * Security Defaults or Conditional Access blocks legacy SMTP password
 * auth (which is most M365 tenants in 2026).
 *
 * Setup (one-time, in Microsoft Entra):
 *   1. Create app registration "Acumon Comms Engine Mailer".
 *   2. API permissions → Microsoft Graph → Application permission
 *      `Mail.Send` → grant admin consent.
 *   3. Certificates & secrets → new client secret → copy the Value.
 *   4. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
 *      GRAPH_FROM (the mailbox to send from, e.g. noreply@acumon.com)
 *      as env vars.
 *
 * Why no SDK: the Graph JS SDK pulls in dozens of MB of transitive
 * deps and we only need two HTTP calls (token + sendMail). Pure
 * fetch keeps the dep tree small and the failure surface narrow.
 *
 * Token caching: client-credentials tokens last ~60 min. We cache
 * with a 5-minute safety margin so we never use a token within 5
 * min of expiry. Cache is in-memory per process — fine for Railway's
 * single-replica deploy; would need shared state for multi-replica
 * (Redis or similar). Re-fetch on cache miss / expiry.
 *
 * Failure modes:
 *   - Token request fails → SendResult FAILED with error message
 *     (invalid client_secret, wrong tenant_id, etc).
 *   - sendMail fails → SendResult FAILED (Mail.Send permission not
 *     granted, GRAPH_FROM mailbox doesn't exist, recipient malformed).
 *   - Network blip → caught + FAILED returned; caller decides
 *     whether to retry.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_SAFETY_MARGIN_SEC = 5 * 60;

let tokenCache: { value: string; expiresAtUnix: number } | null = null;

export function isGraphMailerConfigured(): boolean {
  return Boolean(
    process.env.GRAPH_TENANT_ID &&
      process.env.GRAPH_CLIENT_ID &&
      process.env.GRAPH_CLIENT_SECRET &&
      process.env.GRAPH_FROM,
  );
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAtUnix > now + TOKEN_SAFETY_MARGIN_SEC) {
    return tokenCache.value;
  }
  const tenantId = process.env.GRAPH_TENANT_ID!;
  const clientId = process.env.GRAPH_CLIENT_ID!;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET!;
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    value: data.access_token,
    expiresAtUnix: now + data.expires_in,
  };
  return data.access_token;
}

/**
 * Send an email via Microsoft Graph. Matches the SendInput/SendResult
 * contract from `mailer.ts` so it's a drop-in alternative to
 * `sendNotificationEmail`.
 *
 * The from address comes from GRAPH_FROM env var, not the call site.
 * This matches the EMAIL_FROM behaviour and keeps the from-address
 * decision in one place (env config), not scattered across callers.
 */
export async function sendViaGraph(input: SendInput): Promise<SendResult> {
  if (!isGraphMailerConfigured()) {
    return { status: "SKIPPED_NO_EMAIL_SERVER" };
  }
  try {
    const token = await getAccessToken();
    const from = process.env.GRAPH_FROM!;
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`;
    const body = {
      message: {
        subject: input.subject,
        body: input.html
          ? { contentType: "HTML", content: input.html }
          : { contentType: "Text", content: input.text },
        toRecipients: [{ emailAddress: { address: input.to } }],
      },
      saveToSentItems: false,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const errorMessage = `Graph sendMail ${res.status}: ${text.slice(0, 300)}`;
      reportError(new Error(errorMessage), {
        route: "notifications.graph-mailer",
        tags: { subject: input.subject, status: String(res.status) },
      });
      return { status: "FAILED", errorMessage };
    }
    // Graph sendMail returns 202 Accepted with empty body on success.
    return { status: "DISPATCHED" };
  } catch (err) {
    reportError(err, {
      route: "notifications.graph-mailer",
      tags: { subject: input.subject },
    });
    return {
      status: "FAILED",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reset the in-memory token cache. For tests only — production code
 * relies on natural expiry.
 */
export function _resetGraphTokenCacheForTests() {
  tokenCache = null;
}
