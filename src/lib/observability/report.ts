/**
 * Error reporter — fan out exceptions to configured backends without
 * coupling the codebase to any one SDK.
 *
 * Always:
 *   - Writes a structured error log via {@link log}. That alone is enough
 *     for Railway log-based alerting and for grepping a DEBUG run.
 *
 * Optionally (env-gated):
 *   - `SENTRY_DSN` — POSTs a minimal Sentry "store" payload over HTTPS.
 *     Implements the legacy store endpoint directly so we don't have to
 *     pull the @sentry/node SDK (which carries its own integrations,
 *     instrumentation hooks, and bundle weight). Compatible with both
 *     hosted Sentry and Glitchtip.
 *   - `OBSERVABILITY_WEBHOOK_URL` — POSTs the same payload as plain JSON
 *     to a generic receiver (OTel collector with a webhook receiver, an
 *     internal Slack-relay endpoint, etc).
 *
 * Failures of the reporter itself are swallowed — observability must never
 * break the request path. They surface to the local log only.
 */

import { log, type LogFields } from "./logger";

export type ReportContext = {
  tenantId?: string;
  tenantSlug?: string;
  membershipId?: string;
  userId?: string;
  requestId?: string;
  route?: string;
  /** Free-form tags. Top-level keys become Sentry tags. */
  tags?: Record<string, string | number | boolean>;
  /** Extra contextual fields. Stored as `extra` in Sentry. */
  extra?: LogFields;
};

type SentryDsn = {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
};

function parseDsn(dsn: string): SentryDsn | null {
  try {
    const u = new URL(dsn);
    if (!u.protocol.startsWith("http")) return null;
    if (!u.username) return null;
    const projectId = u.pathname.replace(/^\//, "").split("/").pop();
    if (!projectId) return null;
    return {
      protocol: u.protocol.replace(":", ""),
      publicKey: u.username,
      host: u.host,
      projectId,
    };
  } catch {
    return null;
  }
}

function sentryEnvelopeUrl(dsn: SentryDsn) {
  return `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/store/`;
}

function authHeader(dsn: SentryDsn) {
  const parts = [
    "sentry_version=7",
    `sentry_key=${dsn.publicKey}`,
    "sentry_client=acumon-comm-engine/0.1",
  ];
  return `Sentry ${parts.join(", ")}`;
}

function buildPayload(err: unknown, ctx: ReportContext) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    event_id: cryptoEventId(),
    timestamp: new Date().toISOString(),
    level: "error" as const,
    logger: "communication-engine",
    platform: "node" as const,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.RELEASE_SHA ?? undefined,
    server_name: process.env.RAILWAY_SERVICE_NAME ?? process.env.HOSTNAME ?? undefined,
    message: e.message,
    exception: {
      values: [
        {
          type: e.name,
          value: e.message,
          stacktrace: e.stack ? { frames: parseStack(e.stack) } : undefined,
        },
      ],
    },
    tags: {
      ...(ctx.tenantSlug ? { tenant: ctx.tenantSlug } : {}),
      ...(ctx.route ? { route: ctx.route } : {}),
      ...(ctx.tags ?? {}),
    },
    extra: {
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(ctx.membershipId ? { membershipId: ctx.membershipId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx.extra ?? {}),
    },
  };
}

function parseStack(stack: string) {
  // Sentry expects oldest-first; Node prints newest-first.
  return stack
    .split("\n")
    .slice(1) // drop the leading "Error: msg"
    .map((line) => {
      const m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) return { function: line.trim(), filename: "?" };
      return {
        function: m[1] ?? "<anonymous>",
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
      };
    })
    .reverse();
}

function cryptoEventId() {
  // 32-char hex, no dashes — Sentry-compatible event_id format.
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Fire a payload at every configured backend. Never throws. */
async function dispatch(payload: ReturnType<typeof buildPayload>) {
  const dsn = process.env.SENTRY_DSN ? parseDsn(process.env.SENTRY_DSN) : null;
  const webhook = process.env.OBSERVABILITY_WEBHOOK_URL || null;
  const work: Promise<unknown>[] = [];
  if (dsn) {
    work.push(
      fetch(sentryEnvelopeUrl(dsn), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentry-Auth": authHeader(dsn),
        },
        body: JSON.stringify(payload),
      }).catch((e) => {
        log.warn("sentry dispatch failed", { err: String(e) });
      }),
    );
  }
  if (webhook) {
    work.push(
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((e) => {
        log.warn("observability webhook dispatch failed", { err: String(e) });
      }),
    );
  }
  await Promise.allSettled(work);
}

/**
 * Report an error. Always logs; optionally fans out to remote backends.
 *
 * Shape is "log first, fan out second" — the error is captured in the
 * application log even if a network call to Sentry/the webhook would hang.
 */
export function reportError(err: unknown, ctx: ReportContext = {}, message?: string) {
  const headline = message ?? (err instanceof Error ? err.message : "unhandled error");
  log.error(headline, err, {
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    ...(ctx.tenantSlug ? { tenantSlug: ctx.tenantSlug } : {}),
    ...(ctx.membershipId ? { membershipId: ctx.membershipId } : {}),
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx.route ? { route: ctx.route } : {}),
    ...(ctx.tags ?? {}),
    ...(ctx.extra ?? {}),
  });

  // Fire-and-forget remote dispatch. Detached from the request lifetime.
  if (process.env.SENTRY_DSN || process.env.OBSERVABILITY_WEBHOOK_URL) {
    void dispatch(buildPayload(err, ctx));
  }
}
