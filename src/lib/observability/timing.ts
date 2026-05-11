/**
 * HTTP request timing observability (post-PRD hardening).
 *
 * Parallel to `db-observability.ts` (item 29): there we caught the
 * commonest cause of a slow request (an unbounded DB query); here we
 * catch the request envelope itself so handlers that are slow for non-DB
 * reasons — outbound AI calls, webhook fan-out, CPU-bound work — show up
 * in operator logs the same way.
 *
 * Design choice: warn-level structured log when duration >= threshold,
 * silent otherwise. We deliberately don't emit an info-level row per
 * request — every request would generate a log line and the noise floor
 * would drown the warn signal. Operators who want full request tracing
 * can attach an external collector (Sentry traces, the
 * OBSERVABILITY_WEBHOOK_URL surface) — this module is the cheap floor.
 *
 * Failure mode: the timing wrapper must NEVER suppress the handler's
 * response. A logger crash, a TextDecoder failure, anything — none of
 * it should cause the user to see a 500 instead of the legitimate
 * response. Every observability path is wrapped in try/catch.
 */
import { log } from "./logger";

const DEFAULT_SLOW_REQUEST_MS = 1000;
const MIN_SLOW_REQUEST_MS = 50;
const MAX_LABEL_CHARS = 120;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function getSlowRequestThresholdMs(): number {
  const n = parsePositiveInt(process.env.HTTP_SLOW_REQUEST_MS, DEFAULT_SLOW_REQUEST_MS);
  return Math.max(MIN_SLOW_REQUEST_MS, n);
}

export function sanitiseTimingLabel(label: string): string {
  if (!label) return "(unlabelled)";
  const trimmed = label.trim();
  if (trimmed.length === 0) return "(unlabelled)";
  if (trimmed.length <= MAX_LABEL_CHARS) return trimmed;
  return trimmed.slice(0, MAX_LABEL_CHARS) + "…";
}

export type TimingFields = {
  /** Identifier the operator will grep for. Often `<METHOD> <pathname>`. */
  label: string;
  /** Optional HTTP method shown in the structured fields. */
  method?: string;
  /** Optional pathname shown in the structured fields. */
  pathname?: string;
  /** Optional tenant id captured at the point of timing for correlation. */
  tenantId?: string;
  /** Free-form correlation fields (request id, api key prefix, etc.). */
  extra?: Record<string, unknown>;
};

/**
 * Time a synchronous-or-async unit of work. Returns the work's value
 * unchanged. Logs a warn record when duration >= threshold. Logs the
 * thrown-error case ALSO at warn so a slow handler that also threw is
 * visible — operators usually want both signals.
 */
export async function timeRequest<T>(
  fields: TimingFields,
  fn: () => Promise<T> | T,
  opts: { thresholdMs?: number; statusCode?: () => number | undefined } = {},
): Promise<T> {
  const start = process.hrtime.bigint();
  let threw: unknown = undefined;
  try {
    const out = await fn();
    return out;
  } catch (err) {
    threw = err;
    throw err;
  } finally {
    try {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const threshold = opts.thresholdMs ?? getSlowRequestThresholdMs();
      if (durationMs >= threshold || threw) {
        const statusCode = (() => {
          try {
            return opts.statusCode?.();
          } catch {
            return undefined;
          }
        })();
        log.warn("http slow request", {
          kind: "http-slow-request",
          label: sanitiseTimingLabel(fields.label),
          method: fields.method,
          pathname: fields.pathname,
          tenantId: fields.tenantId,
          durationMs,
          thresholdMs: threshold,
          statusCode,
          threw: threw ? errorTag(threw) : undefined,
          ...sanitiseExtra(fields.extra),
        });
      }
    } catch {
      // Never let the observability path itself suppress the handler.
    }
  }
}

function errorTag(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "Error";
    const message = err.message ? `:${err.message.slice(0, 120)}` : "";
    return `${name}${message}`;
  }
  return String(err).slice(0, 160);
}

function sanitiseExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return {};
  // The logger redactor already strips sensitive keys (token/password/etc.);
  // we just guard against arrays/objects that exceed a reasonable depth or
  // size from accidentally pulling huge payloads into the log line.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Derive a stable timing label from a Request. Falls back to a sentinel
 * if the URL is unparseable so the wrapper still emits useful output.
 */
export function labelForRequest(req: { method: string; url: string }): {
  label: string;
  method: string;
  pathname: string;
} {
  let pathname = "(unparseable)";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    /* keep sentinel */
  }
  return {
    label: `${req.method} ${pathname}`,
    method: req.method,
    pathname,
  };
}
