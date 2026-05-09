import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCachedSystem, type CachedSystemBlock } from "@/lib/ai/client";

let promptCache: Map<string, string> | null = null;

async function loadPrompt(name: string): Promise<string> {
  if (!promptCache) promptCache = new Map();
  const cached = promptCache.get(name);
  if (cached) return cached;
  const path = join(process.cwd(), "src", "lib", "ai", "prompts", `${name}.system.md`);
  const text = await readFile(path, "utf8");
  promptCache.set(name, text);
  return text;
}

export type FCGContext = { committedFcg: unknown; draftFcg?: unknown };
export type UCGContext = { fcg: unknown; ucg?: unknown };

/**
 * System message for the FCG drafting chat. Layered for cache reuse:
 *  1. Static system prompt (cached, 1h)
 *  2. Committed FCG JSON (cached, 1h — invalidates on commit)
 *  3. Working draft FCG (uncached — changes every turn)
 */
export async function fcgSystem(ctx: FCGContext): Promise<CachedSystemBlock[]> {
  const sys = await loadPrompt("fcg");
  return buildCachedSystem([
    { text: sys, cache: true },
    {
      text:
        `# Currently committed Firm Culture Guide\n\n` +
        "```json\n" +
        JSON.stringify(ctx.committedFcg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.draftFcg
      ? [
          {
            text:
              `# Current draft amendment (working)\n\n` +
              "```json\n" +
              JSON.stringify(ctx.draftFcg, null, 2) +
              "\n```",
            cache: false,
          },
        ]
      : []),
  ]);
}

/**
 * System message for the UCG drafting chat. The committed FCG is the
 * authoritative ceiling; the prompt makes that explicit and caches it.
 */
export async function ucgSystem(ctx: UCGContext): Promise<CachedSystemBlock[]> {
  const sys = await loadPrompt("ucg");
  return buildCachedSystem([
    { text: sys, cache: true },
    {
      text:
        `# Authoritative Firm Culture Guide (committed version) — UCG must NOT conflict with this\n\n` +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.ucg
      ? [
          {
            text:
              `# Current draft User Culture Guide\n\n` +
              "```json\n" +
              JSON.stringify(ctx.ucg, null, 2) +
              "\n```",
            cache: false,
          },
        ]
      : []),
  ]);
}

export async function judgeSystem(ctx: { fcg: unknown }): Promise<CachedSystemBlock[]> {
  const sys = await loadPrompt("judge");
  return buildCachedSystem([
    { text: sys, cache: true },
    {
      text:
        `# Authoritative Firm Culture Guide\n\n` +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
  ]);
}

export async function draftSystem(ctx: { fcg: unknown; ucg: unknown; kb?: unknown[] }): Promise<CachedSystemBlock[]> {
  const sys = await loadPrompt("draft");
  return buildCachedSystem([
    { text: sys, cache: true },
    {
      text:
        `# Firm Culture Guide (authoritative)\n\n` +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
    {
      text:
        `# User Culture Guide (this user)\n\n` +
        "```json\n" +
        JSON.stringify(ctx.ucg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.kb && ctx.kb.length
      ? [
          {
            text:
              `# Knowledge Base extracts (use only these for technical claims)\n\n` +
              "```json\n" +
              JSON.stringify(ctx.kb, null, 2) +
              "\n```",
            cache: true,
          },
        ]
      : []),
  ]);
}
