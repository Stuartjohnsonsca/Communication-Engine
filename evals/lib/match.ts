import type { Drift, ExpectationMap, Matcher } from "./types";

/**
 * Walk an expectation map against an actual value and emit drifts.
 *
 * Paths use simple dotted/bracket notation: `rulings.0.verdict`,
 * `perDimension.tone.score`. We only walk indices the path mentions; we
 * do not glob.
 */
export function evaluate(actual: unknown, expected: ExpectationMap): Drift[] {
  const drifts: Drift[] = [];
  for (const [path, matcher] of Object.entries(expected)) {
    const value = readPath(actual, path);
    const result = applyMatcher(value, matcher);
    if (!result.ok) {
      drifts.push({ path, reason: result.reason, expected: matcher, actual: value });
    }
  }
  return drifts;
}

function readPath(root: unknown, path: string): unknown {
  if (path === "" || path === "$") return root;
  const parts = path.split(".").filter((p) => p.length > 0);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

type Result = { ok: true } | { ok: false; reason: string };

function applyMatcher(actual: unknown, matcher: Matcher): Result {
  if (matcher && typeof matcher === "object" && !Array.isArray(matcher)) {
    const m = matcher as Record<string, unknown>;
    if ("exists" in m) {
      const exists = actual !== undefined;
      if (exists !== m.exists) return { ok: false, reason: `exists=${exists}, expected ${m.exists}` };
      return { ok: true };
    }
    if ("in" in m) {
      const list = m.in as unknown[];
      if (!list.some((x) => deepEqual(x, actual))) {
        return { ok: false, reason: `value not in allowed list (got ${stringify(actual)})` };
      }
      return { ok: true };
    }
    if ("min" in m || "max" in m) {
      if (typeof actual !== "number") {
        return { ok: false, reason: `expected number, got ${typeof actual}` };
      }
      if (typeof m.min === "number" && actual < m.min) {
        return { ok: false, reason: `value ${actual} < min ${m.min}` };
      }
      if (typeof m.max === "number" && actual > m.max) {
        return { ok: false, reason: `value ${actual} > max ${m.max}` };
      }
      return { ok: true };
    }
    if ("contains" in m) {
      if (typeof actual !== "string") return { ok: false, reason: `expected string, got ${typeof actual}` };
      const needle = m.contains as string;
      const hay = m.ignoreCase ? actual.toLowerCase() : actual;
      const n = m.ignoreCase ? needle.toLowerCase() : needle;
      if (!hay.includes(n)) return { ok: false, reason: `string did not contain ${stringify(needle)}` };
      return { ok: true };
    }
    if ("matches" in m) {
      if (typeof actual !== "string") return { ok: false, reason: `expected string, got ${typeof actual}` };
      const re = new RegExp(m.matches as string, (m.flags as string) ?? "");
      if (!re.test(actual)) return { ok: false, reason: `string did not match /${m.matches}/${m.flags ?? ""}` };
      return { ok: true };
    }
    if ("length" in m) {
      const lenSpec = m.length as { min?: number; max?: number };
      const len =
        typeof actual === "string" || Array.isArray(actual)
          ? actual.length
          : actual && typeof actual === "object"
            ? Object.keys(actual as Record<string, unknown>).length
            : null;
      if (len === null) return { ok: false, reason: `expected length-able value, got ${typeof actual}` };
      if (typeof lenSpec.min === "number" && len < lenSpec.min) {
        return { ok: false, reason: `length ${len} < min ${lenSpec.min}` };
      }
      if (typeof lenSpec.max === "number" && len > lenSpec.max) {
        return { ok: false, reason: `length ${len} > max ${lenSpec.max}` };
      }
      return { ok: true };
    }
    if ("type" in m) {
      const got = typeOf(actual);
      if (got !== m.type) return { ok: false, reason: `type ${got}, expected ${m.type}` };
      return { ok: true };
    }
  }
  // Fall through — direct deep-equal.
  return deepEqual(actual, matcher)
    ? { ok: true }
    : { ok: false, reason: `expected ${stringify(matcher)}, got ${stringify(actual)}` };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function stringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
