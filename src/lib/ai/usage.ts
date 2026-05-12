import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";
import type { AgentRole, Usage } from "./providers/types";

/**
 * Post-PRD hardening item 55 — LLM usage observability.
 *
 * `recordLlmCall` persists one `LlmCall` row per `chat()` / `callTool()`
 * dispatched on behalf of a tenant. Failures are logged via
 * `reportError` and swallowed — drafting cannot be gated on
 * observability persistence.
 *
 * The recording point is `src/lib/ai/client.ts`. Each agent that
 * already has a tenant in scope passes a `record: { tenantId,
 * context, membershipId? }` opt; the client captures wall-clock
 * duration around the provider call and writes the row.
 *
 * Cost is computed on read (`estimateCostMinor`), not stored — rates
 * change, and recomputing historic rows under new rates is fine for
 * capacity planning. Frozen rate snapshots are a future item for
 * accounting-grade billing.
 */

export type RecordContext = {
  tenantId: string;
  /// Free-form discriminator distinguishing "auto-draft" from
  /// "manual-draft" from "sentiment-classify" from "adherence-score".
  /// Load-bearing: operators slice spend by this to ask "what is the
  /// cron costing me vs what are my Users costing me?"
  context: string;
  membershipId?: string | null;
};

export type RecordLlmCallInput = {
  record: RecordContext;
  role: AgentRole;
  provider: string;
  model: string;
  modelRunId?: string | null;
  usage?: Usage;
  durationMs?: number;
  succeeded: boolean;
  errorMessage?: string | null;
};

export async function recordLlmCall(input: RecordLlmCallInput): Promise<void> {
  try {
    await superDb.llmCall.create({
      data: {
        tenantId: input.record.tenantId,
        membershipId: input.record.membershipId ?? null,
        role: input.role,
        context: input.record.context,
        provider: input.provider,
        model: input.model,
        modelRunId: input.modelRunId ?? null,
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
        cacheCreationTokens: input.usage?.cacheCreationTokens ?? 0,
        durationMs: input.durationMs ?? null,
        succeeded: input.succeeded,
        errorMessage: input.errorMessage ?? null,
      },
    });
  } catch (err) {
    reportError(
      err,
      {
        route: "lib/ai/usage.recordLlmCall",
        tenantId: input.record.tenantId,
        extra: {
          role: input.role,
          context: input.record.context,
          provider: input.provider,
          model: input.model,
        },
      },
      "LlmCall persist failed",
    );
  }
}

/**
 * Per-model rate card in minor units (pence / cents per million tokens).
 *
 * Sources:
 *   - Anthropic published rates as of 2026-05: Sonnet 4.6 $3 in / $15
 *     out / $0.30 cache-read / $3.75 cache-create per MTok; Haiku 4.5
 *     $0.80 in / $4 out / $0.08 cache-read / $1 cache-create.
 *   - Together (Llama 3.3 70B Instruct Turbo) ~$0.88 in/out per MTok.
 *   - Mock provider is free.
 *
 * Rates are in **GBP minor units (pence) per million tokens** so a
 * cost roll-up just needs `(tokens × ratePerMTok) / 1e6`. Currency
 * matches `Tenant.pricingCurrency` default of GBP; multi-currency
 * support is a future item.
 *
 * Unknown models fall through to the provider default; unknown
 * providers fall through to zero (we'd rather show zero than guess).
 */
type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreationPerMTok: number;
};

const USD_TO_GBP = 0.79; // approximate; recomputed centrally if needed
const USD_PER_GBP_INV = 100; // pence
function usdToPence(usd: number): number {
  return Math.round(usd * USD_TO_GBP * USD_PER_GBP_INV);
}

const MODEL_RATES: Record<string, ModelRate> = {
  "claude-sonnet-4-6": {
    inputPerMTok: usdToPence(3),
    outputPerMTok: usdToPence(15),
    cacheReadPerMTok: usdToPence(0.3),
    cacheCreationPerMTok: usdToPence(3.75),
  },
  "claude-haiku-4-5-20251001": {
    inputPerMTok: usdToPence(0.8),
    outputPerMTok: usdToPence(4),
    cacheReadPerMTok: usdToPence(0.08),
    cacheCreationPerMTok: usdToPence(1),
  },
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
    inputPerMTok: usdToPence(0.88),
    outputPerMTok: usdToPence(0.88),
    cacheReadPerMTok: 0,
    cacheCreationPerMTok: 0,
  },
  mock: {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheCreationPerMTok: 0,
  },
};

export function estimateCostMinor(row: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const rate = MODEL_RATES[row.model];
  if (!rate) return 0;
  const cost =
    (row.inputTokens * rate.inputPerMTok +
      row.outputTokens * rate.outputPerMTok +
      row.cacheReadTokens * rate.cacheReadPerMTok +
      row.cacheCreationTokens * rate.cacheCreationPerMTok) /
    1_000_000;
  return Math.round(cost);
}
