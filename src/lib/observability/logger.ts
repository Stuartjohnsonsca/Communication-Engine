/**
 * Structured logger.
 *
 * - JSON one-line records in production (machine-readable for Railway logs /
 *   any downstream collector).
 * - Pretty single-line records in development for human reading.
 * - Levels: silent < error < warn < info < debug. Threshold from `LOG_LEVEL`
 *   env, defaulting to `info` (production) / `debug` (development).
 * - Automatic redaction of sensitive field names anywhere in the structured
 *   payload — `token`, `password`, `secret`, etc. Defence-in-depth so a
 *   dropped object literal can't leak credentials to logs.
 * - `log.with({...})` returns a child logger whose extra fields are merged
 *   into every record. Used by request-scoped helpers to bind `requestId`,
 *   `tenantId`, `route`, `membershipId` once per request.
 *
 * Use-site contract: pass structured fields, never string-format them. Bad:
 *   log.info(`processed ${n} drafts for ${tenantId}`)
 * Good:
 *   log.info("processed drafts", { count: n, tenantId })
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "clientsecret",
  "encryptionkey",
  "anthropicapikey",
  "togetherapikey",
]);

const REDACTED = "[redacted]";

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

let activeLevel: LogLevel = envLevel();

export function setLogLevel(level: LogLevel) {
  activeLevel = level;
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

function shouldEmit(level: Exclude<LogLevel, "silent">) {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[activeLevel];
}

export type LogFields = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(typeof (value as { cause?: unknown }).cause !== "undefined"
        ? { cause: redact((value as { cause?: unknown }).cause, depth + 1) }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, errOrFields?: unknown, fields?: LogFields) => void;
  with: (extra: LogFields) => Logger;
};

const SERVICE = "communication-engine";

function emit(level: Exclude<LogLevel, "silent">, msg: string, bound: LogFields, fields?: LogFields) {
  if (!shouldEmit(level)) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    msg,
    ...redact({ ...bound, ...(fields ?? {}) }) as LogFields,
  };
  const isProd = process.env.NODE_ENV === "production";
  const line = isProd ? JSON.stringify(record) : prettyLine(record);
  // Always go through the same stream so test capture is consistent.
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function prettyLine(record: Record<string, unknown>) {
  const { ts, level, msg, service: _service, ...rest } = record;
  const tag = String(level).toUpperCase().padEnd(5);
  const head = `${ts} ${tag} ${msg}`;
  const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return head + tail;
}

function makeLogger(bound: LogFields): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, bound, fields),
    info: (msg, fields) => emit("info", msg, bound, fields),
    warn: (msg, fields) => emit("warn", msg, bound, fields),
    error: (msg, errOrFields, fields) => {
      let merged: LogFields | undefined = fields;
      if (errOrFields instanceof Error) {
        merged = { err: errOrFields, ...(fields ?? {}) };
      } else if (errOrFields && typeof errOrFields === "object") {
        merged = { ...(errOrFields as LogFields), ...(fields ?? {}) };
      } else if (typeof errOrFields !== "undefined") {
        merged = { detail: errOrFields, ...(fields ?? {}) };
      }
      emit("error", msg, bound, merged);
    },
    with: (extra) => makeLogger({ ...bound, ...extra }),
  };
}

export const log: Logger = makeLogger({});

/**
 * Build a logger pre-bound to request-scoped fields. Pass whatever you have
 * — partial context is fine.
 */
export function loggerFor(fields: LogFields): Logger {
  return log.with(fields);
}
