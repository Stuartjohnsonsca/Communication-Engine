#!/usr/bin/env tsx
/**
 * Eval CLI.
 *
 * Usage:
 *   tsx evals/cli.ts <role> [--json] [--only=<regex>]
 *   tsx evals/cli.ts all   [--json] [--only=<regex>]
 *
 * Roles: judge, draft, adherence, sentiment, opportunity, fcg, ucg.
 *
 * Always exits 0 — the harness reports drift visibly but does not gate
 * deployment. PRD §17 lists "judge inconsistency" as a Medium-risk item
 * where the mitigation is drift detection, not drift blocking.
 */

import { runRole, reportText, reportJson } from "./lib/runner";
import { adherenceAdapter } from "./adherence/run";
import { draftAdapter } from "./draft/run";
import { fcgAdapter } from "./fcg/run";
import { judgeAdapter } from "./judge/run";
import { opportunityAdapter } from "./opportunity/run";
import { sentimentAdapter } from "./sentiment/run";
import { ucgAdapter } from "./ucg/run";
import type { AgentRole } from "@/lib/ai/providers/types";
import type { Adapter, RoleResult } from "./lib/types";

type RoleSpec = {
  adapter: Adapter;
  agentRole: AgentRole;
};

const ROLES: Record<string, RoleSpec> = {
  judge:       { adapter: judgeAdapter,       agentRole: "judge" },
  draft:       { adapter: draftAdapter,       agentRole: "draft" },
  adherence:   { adapter: adherenceAdapter,   agentRole: "adherence" },
  sentiment:   { adapter: sentimentAdapter,   agentRole: "sentiment" },
  opportunity: { adapter: opportunityAdapter, agentRole: "opportunity" },
  fcg:         { adapter: fcgAdapter,         agentRole: "fcg-chat" },
  ucg:         { adapter: ucgAdapter,         agentRole: "ucg-chat" },
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const target = positional[0];
  if (!target) {
    process.stderr.write("usage: tsx evals/cli.ts <role|all> [--json] [--only=<regex>]\n");
    process.exit(2);
  }
  const only = typeof flags.only === "string" ? new RegExp(flags.only) : undefined;
  const json = flags.json === true;

  const roles =
    target === "all" ? Object.keys(ROLES) : ROLES[target] ? [target] : null;
  if (!roles) {
    process.stderr.write(
      `unknown role "${target}". Known: ${Object.keys(ROLES).join(", ")}, or "all".\n`,
    );
    process.exit(2);
  }

  const results: RoleResult[] = [];
  for (const r of roles) {
    const spec = ROLES[r];
    const result = await runRole(spec.adapter, spec.agentRole, { only, json });
    results.push(result);
  }
  process.stdout.write((json ? reportJson(results) : reportText(results)) + "\n");
}

main().catch((e) => {
  process.stderr.write(`eval harness crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  // The harness itself crashing IS a problem worth surfacing — exit non-zero
  // here so a syntax error in a fixture doesn't quietly pass CI. (Drift in
  // an individual case still exits 0 via the normal code path.)
  process.exit(1);
});
