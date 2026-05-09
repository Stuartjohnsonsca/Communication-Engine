/**
 * Model defaults per agent role. Phase 1 differentiates by role + prompt +
 * caching, not by model id — every agent runs on Sonnet 4.6.
 *
 * To migrate to a different model later, change the value here and
 * recheck the prompt cache hit rate (model id is part of the cache key).
 */
export const SONNET = "claude-sonnet-4-6" as const;

export type AgentRole =
  | "fcg-chat"
  | "ucg-chat"
  | "judge"
  | "draft"
  | "verifier"
  | "adherence"
  | "sentiment"
  | "opportunity";

export const MODEL_FOR: Record<AgentRole, { model: string; maxTokens: number; temperature: number }> = {
  "fcg-chat":   { model: SONNET, maxTokens: 4096, temperature: 0.5 },
  "ucg-chat":   { model: SONNET, maxTokens: 4096, temperature: 0.5 },
  "judge":      { model: SONNET, maxTokens: 4096, temperature: 0   },
  "draft":      { model: SONNET, maxTokens: 4096, temperature: 0.4 },
  "verifier":   { model: SONNET, maxTokens: 1024, temperature: 0   },
  "adherence":  { model: SONNET, maxTokens: 2048, temperature: 0   },
  "sentiment":  { model: SONNET, maxTokens: 1024, temperature: 0   },
  "opportunity":{ model: SONNET, maxTokens: 2048, temperature: 0.2 },
};
