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

export async function adherenceSystem(ctx: { fcg: unknown; ucg: unknown }): Promise<SystemBlock[]> {
  const sys = await loadPrompt("adherence");
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
    {
      text:
        "# User Culture Guide (this user, suspended rules excluded)\n\n" +
        "```json\n" +
        JSON.stringify(ctx.ucg, null, 2) +
        "\n```",
      cache: true,
    },
  ]);
}

export async function sentimentSystem(): Promise<SystemBlock[]> {
  const sys = await loadPrompt("sentiment");
  return buildSystem([{ text: sys, cache: true }]);
}

export type OpportunityContext = {
  jurisdiction: string;
  /// Short string the firm uses to describe its service mix; helps the model
  /// keep `serviceLine` suggestions on-vocabulary.
  serviceLineHints?: string[];
};
export async function opportunitySystem(ctx: OpportunityContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("opportunity");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Tenant context\n\n" +
        "```json\n" +
        JSON.stringify(
          {
            tenantJurisdiction: ctx.jurisdiction,
            serviceLineHints: ctx.serviceLineHints ?? [],
          },
          null,
          2,
        ) +
        "\n```",
      cache: true,
    },
  ]);
}

export type MeetingPaperContext = {
  fcg: unknown;
  meeting: unknown;
  participants: unknown[];
  priorContext?: unknown[];
};
export async function meetingPaperSystem(ctx: MeetingPaperContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("meeting");
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
    ...(ctx.priorContext && ctx.priorContext.length
      ? [
          {
            text:
              "# Prior context (use generically — do not fabricate quotes or figures)\n\n" +
              "```json\n" +
              JSON.stringify(ctx.priorContext, null, 2) +
              "\n```",
            cache: true,
          },
        ]
      : []),
  ]);
}

export type MeetingRecordContext = {
  /// "summary" or "minutes" — the agent uses this to pick the document shape
  /// (PRD §7.5 distinguishes a discursive Summary from formal Minutes).
  kind: "summary" | "minutes";
  fcg: unknown;
  meeting: unknown;
  participants: unknown[];
  /// Original meeting paper (agenda, discussion paper, open questions). When
  /// present the agent writes Minutes that track the agenda items in order so
  /// the audit reader can match up "what was tabled" with "what was decided".
  priorPaper?: unknown;
};
export async function meetingRecordSystem(ctx: MeetingRecordContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("meeting-minutes");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Authoritative Firm Culture Guide (drives tone, mandatory phrases, signature)\n\n" +
        "```json\n" +
        JSON.stringify(ctx.fcg, null, 2) +
        "\n```",
      cache: true,
    },
    {
      text: `# Document kind\n\nProduce a **${ctx.kind === "minutes" ? "formal Minutes" : "Summary"}** record. ${ctx.kind === "minutes" ? "Numbered, formal, with explicit Decisions and Actions sections; suitable for the audit record." : "Discursive prose summary; shorter than formal minutes; covers what was discussed and any agreed next steps but does not need numbered items."}`,
      cache: false,
    },
    ...(ctx.priorPaper
      ? [
          {
            text:
              "# Pre-meeting paper (agenda + discussion paper that was tabled)\n\n" +
              "```json\n" +
              JSON.stringify(ctx.priorPaper, null, 2) +
              "\n```",
            cache: true,
          },
        ]
      : []),
  ]);
}

export type CultureScanContext = {
  /// Tenant-level facts the analyser should know up front: jurisdiction, the
  /// language(s) the firm operates in, the channel kinds in scope, and the
  /// observed date range. These bias the rule defaults (e.g. en-GB salutations
  /// for UK firms) without prejudicing what the corpus actually shows.
  tenantJurisdiction: string;
  workingLanguage: string;
  channelsInScope: string[];
  dateRangeFrom: string;
  dateRangeTo: string;
  /// Sampled IngestedMessage rows. Each one has `id`, `direction`, `sender`,
  /// `subject`, `body`, `sentAt`, and the channel kind. The model uses message
  /// `id` values in `evidenceMessageIds` to point back at what it observed.
  corpus: unknown[];
};
export async function cultureScanSystem(ctx: CultureScanContext): Promise<SystemBlock[]> {
  const sys = await loadPrompt("culture-scan");
  return buildSystem([
    { text: sys, cache: true },
    {
      text:
        "# Tenant context\n\n" +
        "```json\n" +
        JSON.stringify(
          {
            jurisdiction: ctx.tenantJurisdiction,
            workingLanguage: ctx.workingLanguage,
            channelsInScope: ctx.channelsInScope,
            dateRangeFrom: ctx.dateRangeFrom,
            dateRangeTo: ctx.dateRangeTo,
            corpusSize: ctx.corpus.length,
          },
          null,
          2,
        ) +
        "\n```",
      cache: false,
    },
    {
      text:
        "# Sampled FCT communications corpus\n\n" +
        "Use the `id` field of any message you cite in `evidenceMessageIds`.\n\n" +
        "```json\n" +
        JSON.stringify(ctx.corpus, null, 2) +
        "\n```",
      cache: false,
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
