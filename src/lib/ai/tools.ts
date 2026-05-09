import type { ToolDef } from "@/lib/ai/providers/types";

/**
 * Tool definitions, provider-agnostic. JSON Schema input.
 * Anthropic uses `input_schema`, OpenAI/Together uses `parameters` —
 * provider adapters do the rename.
 */

const ruleSchema = {
  type: "object",
  properties: {
    externalId: { type: "string" },
    category: {
      type: "string",
      enum: ["tone","response_time","salutation","signoff","signature","mandatory_phrase","prohibited_phrase","escalation","regulatory","language"],
    },
    channel: {
      type: "string",
      enum: ["email","slack","teams","letter","report","whatsapp_business","any"],
      default: "any",
    },
    statement: { type: "string" },
    payload: { type: "object" },
    rationale: { type: "string" },
    mandatory: { type: "boolean", default: false },
    priority: { type: "integer", default: 100 },
    evidenceRefs: { type: "array", items: { type: "string" }, default: [] },
    channelOverrides: { type: "object" },
  },
  required: ["externalId","category","statement"],
} as const;

export const fcgTools: ToolDef[] = [
  {
    name: "propose_rule_change",
    description:
      "Stage a single add/modify/remove operation on the working FCG draft. The FCT will see the staged operation and may approve, reject, or refine before the proposal goes to a vote.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add","modify","remove"] },
        rule: ruleSchema,
        ruleIdToModify: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["action","rule"],
    },
  },
  {
    name: "summarise_section",
    description: "Produce a short summary of one FCG category and return it inline to the chat.",
    schema: {
      type: "object",
      properties: { category: { type: "string" }, summary: { type: "string" } },
      required: ["category","summary"],
    },
  },
  {
    name: "request_evidence",
    description: "Ask the server for scan extracts you need to ground a rule. Server returns matching snippets.",
    schema: {
      type: "object",
      properties: { query: { type: "string" }, k: { type: "integer", default: 5 } },
      required: ["query"],
    },
  },
  {
    name: "finalise_fcg",
    description: "Hand the full proposed FCG (all rules + signature block) over for FCT vote.",
    schema: {
      type: "object",
      properties: {
        rules: { type: "array", items: ruleSchema },
        signatureBlock: { type: "object" },
        notes: { type: "string" },
      },
      required: ["rules"],
    },
  },
];

const ucgRuleSchema = {
  ...ruleSchema,
  properties: {
    ...ruleSchema.properties,
    narrowsFcgRule: { type: ["string","null"] },
  },
} as const;

export const ucgTools: ToolDef[] = [
  {
    name: "propose_user_rule",
    description: "Stage a single add/modify/remove on the working UCG draft. Will be screened against the FCG.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add","modify","remove"] },
        rule: ucgRuleSchema,
        ruleIdToModify: { type: "string" },
      },
      required: ["action","rule"],
    },
  },
  {
    name: "request_clarification",
    description: "Ask the user a follow-up question.",
    schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "flag_fcg_conflict_for_amendment",
    description:
      "User wants something the FCG forbids. Emit an FCG amendment proposal request that the FCT can act on.",
    schema: {
      type: "object",
      properties: { fcgRuleId: { type: "string" }, reason: { type: "string" } },
      required: ["fcgRuleId","reason"],
    },
  },
  {
    name: "finalise_ucg",
    description: "Hand the full UCG draft to the Judge for compliance evaluation.",
    schema: {
      type: "object",
      properties: {
        rules: { type: "array", items: ucgRuleSchema },
        signatureBlock: { type: "object" },
        notes: { type: "string" },
      },
      required: ["rules"],
    },
  },
];

export const judgeTool: ToolDef = {
  name: "respond_with_judgement",
  description: "Return the structured compliance verdict for the candidate UCG against the authoritative FCG.",
  schema: {
    type: "object",
    properties: {
      overall: { type: "string", enum: ["pass","fail","partial"] },
      rulings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ucgRuleId: { type: "string" },
            verdict: { type: "string", enum: ["pass","fail","not_applicable"] },
            fcgClauseCited: { type: ["string","null"] },
            explanation: { type: "string", maxLength: 800 },
            severity: { type: ["string","null"], enum: ["blocking","advisory",null] },
            suggestedFix: { type: ["string","null"] },
          },
          required: ["ucgRuleId","verdict","explanation"],
        },
      },
    },
    required: ["overall","rulings"],
  },
};

const adherenceDimSchema = {
  type: "object",
  properties: {
    score: { type: ["number", "null"], minimum: 0, maximum: 1 },
    verdict: { type: "string", enum: ["pass", "partial", "fail", "not_applicable"] },
    evidence: { type: "string", maxLength: 400 },
  },
  required: ["score", "verdict"],
} as const;

export const adherenceTool: ToolDef = {
  name: "respond_with_adherence",
  description:
    "Return the structured adherence score for a single sent communication, scored against the FCG and UCG provided in the system prompt.",
  schema: {
    type: "object",
    properties: {
      perDimension: {
        type: "object",
        properties: {
          responseTime: adherenceDimSchema,
          tone: adherenceDimSchema,
          mandatoryPhrase: adherenceDimSchema,
          prohibitedPhrase: adherenceDimSchema,
          escalation: adherenceDimSchema,
        },
        required: ["responseTime", "tone", "mandatoryPhrase", "prohibitedPhrase", "escalation"],
      },
      perRule: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ruleExternalId: { type: "string" },
            source: { type: "string", enum: ["fcg", "ucg"] },
            verdict: { type: "string", enum: ["pass", "fail"] },
            explanation: { type: "string", maxLength: 400 },
          },
          required: ["ruleExternalId", "source", "verdict", "explanation"],
        },
        default: [],
      },
      overall: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["perDimension", "overall"],
  },
};

export const sentimentTool: ToolDef = {
  name: "respond_with_sentiment",
  description:
    "Return the structured sentiment classification for a single inbound external communication, scoped to PRD §9.3 (counterparty dissatisfaction with firm handling).",
  schema: {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: ["extreme_negative", "extreme_positive", "neutral"],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      isAboutFirmHandling: { type: "boolean" },
      evidenceSpans: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", maxLength: 200 },
            start: { type: "integer" },
            end: { type: "integer" },
          },
          required: ["text"],
        },
        default: [],
      },
      trigger: { type: ["string", "null"] },
      shouldEscalate: { type: "boolean" },
    },
    required: ["classification", "confidence", "isAboutFirmHandling", "shouldEscalate"],
  },
};

export const draftTool: ToolDef = {
  name: "respond_with_draft",
  description: "Return the final draft. Terminates the turn. Must be called exactly once and last.",
  schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["substantive","holding","technical","holding_research"] },
      channel: { type: "string", enum: ["email","slack","teams","letter","report","whatsapp_business","any"] },
      language: { type: "string", default: "en-GB" },
      subject: { type: ["string","null"] },
      body: { type: "string" },
      citations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            marker: { type: "string" },
            source: { type: "string" },
            locator: { type: "string" },
            claim: { type: "string" },
          },
          required: ["marker","source","claim"],
        },
        default: [],
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            type: { type: "string", enum: ["task","calendar","followup","research"], default: "task" },
            dueAt: { type: ["string","null"] },
          },
          required: ["title"],
        },
        default: [],
      },
      holdingRequired: { type: "boolean", default: false },
      holdingReason: { type: ["string","null"] },
      fcgWindowDeadline: { type: ["string","null"] },
      noGoSubjectHit: { type: "boolean", default: false },
      researchTaskRequired: { type: "boolean", default: false },
    },
    required: ["type","channel","body"],
  },
};
