import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSystem } from "@/lib/ai/client";
import type { SystemBlock } from "@/lib/ai/providers/types";

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

export async function fcgSystem(ctx: FCGContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("fcg");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Currently committed Firm Culture Guide\n\n" +
        "```json\n" +
        JSON.stringify(ctx.committedFcg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.draftFcg
      ? [
          {
            text:
              "# Current draft amendment (working)\n\n" +
              "```json\n" +
              JSON.stringify(ctx.draftFcg, null, 2) +
              "\n```",
            cache: false,
          },
        ]
      : []),
  ]);
}

export async function ucgSystem(ctx: UCGContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("ucg");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Authoritative Firm Culture Guide (committed version) — UCG must NOT conflict with this\n\n" +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.ucg
      ? [
          {
            text:
              "# Current draft User Culture Guide\n\n" +
              "```json\n" +
              JSON.stringify(ctx.ucg, null, 2) +
              "\n```",
            cache: false,
          },
        ]
      : []),
  ]);
}

export async function judgeSystem(ctx: { fcg: unknown }): Promise<SystemBlock[]> {
  const sys = await loadPrompt("judge");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Authoritative Firm Culture Guide\n\n" +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
  ]);
}

export async function draftSystem(ctx: { fcg: unknown; ucg: unknown; kb?: unknown[] }): Promise<SystemBlock[]> {
  const sys = await loadPrompt("draft");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Firm Culture Guide (authoritative)\n\n" +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
    {
      text:
        "# User Culture Guide (this user)\n\n" +
        "```json\n" +
        JSON.stringify(ctx.ucg, null, 2) +
        "\n```",
      cache: true,
    },
    ...(ctx.kb && ctx.kb.length
      ? [
          {
            text:
              "# Knowledge Base extracts (use only these for technical claims)\n\n" +
              "```json\n" +
              JSON.stringify(ctx.kb, null, 2) +
              "\n```",
            cache: true,
          },
        ]
      : []),
  ]);
}
