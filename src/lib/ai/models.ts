import type { AgentRole } from "./providers/types";

export type ModelBinding = {
  provider: string; // "anthropic" | "together" | "mock"
  model: string;
  maxTokens: number;
  temperature: number;
};

/**
 * Default per-role model bindings.
 *
 * Cost/quality strategy:
 *  - Compliance Judge stays on Sonnet — strict structured reasoning is the
 *    quality bottleneck for the whole product (PRD §5.3) and Llama 3.3 has
 *    measurably lower reliability on per-rule pass/fail with citation.
 *  - Statutory verifier stays on Haiku — cheap but accurate; second pass
 *    that suppresses unverified citations.
 *  - Everything else defaults to Llama 3.3 70B Turbo on Together — high
 *    volume, drafting/classification tasks where Llama is good enough.
 *
 * Override any role at runtime with an env var of the form:
 *   LLM_<ROLE>=<provider>:<model>
 * e.g. `LLM_FCG_CHAT=anthropic:claude-sonnet-4-6`,
 *      `LLM_DRAFT=together:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8`,
 *      `LLM_JUDGE=mock:mock`.
 *
 * A blanket `LLM_DEFAULT=<provider>:<model>` overrides everything that
 * doesn't have a more specific override.
 */
const DEFAULTS: Record<AgentRole, ModelBinding> = {
  "fcg-chat":    { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 4096, temperature: 0.5 },
  "ucg-chat":    { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 4096, temperature: 0.5 },
  "judge":       { provider: "anthropic", model: "claude-sonnet-4-6",                       maxTokens: 4096, temperature: 0   },
  "draft":       { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 4096, temperature: 0.4 },
  "verifier":    { provider: "anthropic", model: "claude-haiku-4-5-20251001",               maxTokens: 1024, temperature: 0   },
  "adherence":   { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 2048, temperature: 0   },
  "sentiment":   { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 1024, temperature: 0   },
  "opportunity": { provider: "together",  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 2048, temperature: 0.2 },
  "meeting-paper": { provider: "together", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", maxTokens: 4096, temperature: 0.4 },
};

const ENV_KEY: Record<AgentRole, string> = {
  "fcg-chat":    "LLM_FCG_CHAT",
  "ucg-chat":    "LLM_UCG_CHAT",
  "judge":       "LLM_JUDGE",
  "draft":       "LLM_DRAFT",
  "verifier":    "LLM_VERIFIER",
  "adherence":   "LLM_ADHERENCE",
  "sentiment":   "LLM_SENTIMENT",
  "opportunity": "LLM_OPPORTUNITY",
  "meeting-paper": "LLM_MEETING_PAPER",
};

function parseSpec(spec: string | undefined): { provider: string; model: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf(":");
  if (idx <= 0) return null;
  return { provider: spec.slice(0, idx).trim(), model: spec.slice(idx + 1).trim() };
}

export function bindingFor(role: AgentRole): ModelBinding {
  const def = DEFAULTS[role];
  const fallbackDefault = parseSpec(process.env.LLM_DEFAULT);
  const specific = parseSpec(process.env[ENV_KEY[role]]);

  return {
    ...def,
    ...(fallbackDefault ? fallbackDefault : {}),
    ...(specific ? specific : {}),
    maxTokens: def.maxTokens,
    temperature: def.temperature,
  };
}

export const SONNET = "claude-sonnet-4-6" as const;
export const HAIKU = "claude-haiku-4-5-20251001" as const;
export const LLAMA_33_70B = "meta-llama/Llama-3.3-70B-Instruct-Turbo" as const;
