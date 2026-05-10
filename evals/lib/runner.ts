import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { evaluate } from "./match";
import type { Adapter, CaseResult, Fixture, RoleResult } from "./types";
import { effectiveProvider } from "@/lib/ai/providers";
import { bindingFor } from "@/lib/ai/models";
import type { AgentRole } from "@/lib/ai/providers/types";

export type RunOpts = {
  /** Directory containing `fixtures/*.json`. Defaults to `evals/<adapter.role>`. */
  baseDir?: string;
  /** When set, only fixtures whose `name` matches are run. */
  only?: RegExp;
  /** Emit machine-readable JSON (one record per role). */
  json?: boolean;
};

export async function runRole(
  adapter: Adapter,
  agentRole: AgentRole,
  opts: RunOpts = {},
): Promise<RoleResult> {
  const baseDir = opts.baseDir ?? join(process.cwd(), "evals", adapter.role);
  const fixturesDir = join(baseDir, "fixtures");
  const fixtures = await loadFixtures(fixturesDir, opts.only);

  const binding = bindingFor(agentRole);
  const provider = effectiveProvider(binding.provider);
  const providerName = provider.name;

  const t0 = Date.now();
  const cases: CaseResult[] = [];
  for (const fx of fixtures) {
    const start = Date.now();
    const fxName = fx.name ?? "<unnamed>";
    if (fx.liveOnly && providerName === "mock") {
      cases.push({
        fixture: fxName,
        status: "skip",
        durationMs: 0,
        drifts: [],
        errorMessage: "liveOnly fixture skipped under mock provider",
      });
      continue;
    }
    const expected =
      fx.expectedByProvider?.[providerName] ?? fx.expected ?? null;
    if (!expected) {
      cases.push({
        fixture: fxName,
        status: "skip",
        durationMs: 0,
        drifts: [],
        errorMessage: `no expectations for provider=${providerName}`,
      });
      continue;
    }
    try {
      const actual = await adapter.run(fx.input);
      const drifts = evaluate(actual, expected);
      cases.push({
        fixture: fxName,
        status: drifts.length ? "fail" : "pass",
        durationMs: Date.now() - start,
        drifts,
      });
    } catch (e) {
      cases.push({
        fixture: fxName,
        status: "error",
        durationMs: Date.now() - start,
        drifts: [],
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const result: RoleResult = {
    role: adapter.role,
    provider: providerName,
    cases,
    passed: cases.filter((c) => c.status === "pass").length,
    failed: cases.filter((c) => c.status === "fail").length,
    skipped: cases.filter((c) => c.status === "skip").length,
    errored: cases.filter((c) => c.status === "error").length,
    durationMs: Date.now() - t0,
  };
  return result;
}

async function loadFixtures(dir: string, only?: RegExp): Promise<Fixture[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const fixtures: Fixture[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    let parsed: Fixture;
    try {
      parsed = JSON.parse(text) as Fixture;
    } catch (e) {
      throw new Error(`fixture ${f} is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
    if (!parsed.name) parsed.name = basename(f, ".json");
    if (only && !only.test(parsed.name)) continue;
    fixtures.push(parsed);
  }
  return fixtures;
}

export function reportText(results: RoleResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      `\n# ${r.role} (provider=${r.provider}, ${r.cases.length} case${r.cases.length === 1 ? "" : "s"}, ${r.durationMs}ms)`,
    );
    for (const c of r.cases) {
      const marker =
        c.status === "pass"
          ? "ok"
          : c.status === "fail"
            ? "drift"
            : c.status === "skip"
              ? "skip"
              : "err";
      const dur = `${c.durationMs}ms`;
      lines.push(`  [${marker.padEnd(5)}] ${c.fixture.padEnd(40)} ${dur.padStart(7)}`);
      if (c.status === "fail") {
        for (const d of c.drifts) {
          lines.push(`           - ${d.path}: ${d.reason}`);
        }
      } else if (c.status === "error" || c.status === "skip") {
        if (c.errorMessage) lines.push(`           ${c.errorMessage}`);
      }
    }
    lines.push(
      `  → ${r.passed} passed, ${r.failed} drift, ${r.skipped} skip, ${r.errored} err`,
    );
  }
  const totals = results.reduce(
    (acc, r) => {
      acc.passed += r.passed;
      acc.failed += r.failed;
      acc.skipped += r.skipped;
      acc.errored += r.errored;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0, errored: 0 },
  );
  lines.push(
    `\nTotals: ${totals.passed} passed, ${totals.failed} drift, ${totals.skipped} skip, ${totals.errored} err`,
  );
  return lines.join("\n");
}

export function reportJson(results: RoleResult[]): string {
  return JSON.stringify({ schema: "acumon.evals@1", results }, null, 2);
}
