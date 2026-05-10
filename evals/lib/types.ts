/**
 * Eval harness types.
 *
 * A *fixture* is a JSON file under `evals/<role>/fixtures/<name>.json`. Each
 * one carries:
 *  - `name` (overrides filename if present)
 *  - `input` — opaque to the runner; passed straight to the role-specific
 *    adapter in `evals/<role>/run.ts`
 *  - `expected` — a flat path → matcher map; see `match.ts` for the matchers
 *    that are supported (deep-equal, in/min/max, contains, length)
 *  - `expectedByProvider` — optional override map keyed by provider name
 *    (`mock`, `together`, `anthropic`). When the active provider has an
 *    entry, that map is used INSTEAD of `expected`. Lets us state "this
 *    fixture should pass under mock with these tame expectations, and
 *    under live with stricter ones" without forking files.
 *  - `tags` — informational; used for grouping in the report.
 *
 * The harness deliberately exits 0 even on drift — it's a *visibility*
 * tool. PRD §17 lists "judge inconsistency" as a Medium-risk item where
 * the mitigation is drift detection, not drift blocking. CI surfaces drift
 * in logs; promoting drift to a blocking gate is a follow-up once we have
 * baseline noise numbers from real provider runs.
 */

export type Matcher =
  | unknown // direct deep-equals
  | { in: unknown[] } // value must be one of
  | { min?: number; max?: number } // numeric range
  | { contains: string; ignoreCase?: boolean } // substring
  | { matches: string; flags?: string } // regex test
  | { length: { min?: number; max?: number } } // array/string length
  | { type: "string" | "number" | "boolean" | "object" | "array" | "null" }
  | { exists: boolean };

export type ExpectationMap = Record<string, Matcher>;

export type Fixture = {
  name?: string;
  input: unknown;
  expected?: ExpectationMap;
  expectedByProvider?: Record<string, ExpectationMap>;
  tags?: string[];
  /** When true, skip this case unless a non-mock provider is active. */
  liveOnly?: boolean;
};

export type CaseResult = {
  fixture: string;
  status: "pass" | "fail" | "skip" | "error";
  durationMs: number;
  drifts: Drift[];
  errorMessage?: string;
};

export type Drift = {
  path: string;
  reason: string;
  expected?: unknown;
  actual?: unknown;
};

export type RoleResult = {
  role: string;
  provider: string;
  cases: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  durationMs: number;
};

export type Adapter = {
  /** Role name in `package.json` script suffix (also dir name). */
  role: string;
  /** Returns the actual output that will be matched against `expected`. */
  run(input: unknown): Promise<unknown>;
};
