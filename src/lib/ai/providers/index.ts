import { anthropicProvider } from "./anthropic";
import { mockProvider } from "./mock";
import { togetherProvider } from "./together";
import type { LLMProvider } from "./types";

export const PROVIDERS: Record<string, LLMProvider> = {
  anthropic: anthropicProvider,
  together: togetherProvider,
  mock: mockProvider,
};

export type ProviderName = keyof typeof PROVIDERS;

export function getProvider(name: string): LLMProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown LLM provider: ${name}`);
  return p;
}

/**
 * Resolve the effective provider for a binding. If the configured provider
 * has no API key set, fall back in order: anthropic → together → mock.
 * The `mock` provider is always considered configured so the app stays
 * functional in any environment (with synthetic outputs).
 */
export function effectiveProvider(name: string): LLMProvider {
  const direct = getProvider(name);
  if (direct.isConfigured()) return direct;
  for (const candidate of ["anthropic", "together", "mock"]) {
    const p = PROVIDERS[candidate];
    if (p?.isConfigured()) return p;
  }
  return mockProvider;
}
