import type Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic tool definitions. Each `respond_with_X` tool is forced via
 * `tool_choice: { type: 'tool', name: ... }` so the model emits one
 * structured payload and stops.
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

export const fcgTools: Anthropic.Messages.Tool[] = [
  {
    name: "propose_rule_change",
    description:
      "Stage a single add/modify/remove operation on the working FCG draft. The FCT will see the staged operation and may approve, reject, or refine before the proposal goes to a vote.",
    input_schema: {
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
    input_schema: {
      type: "object",
      properties: { category: { type: "string" }, summary: { type: "string" } },
      required: ["category","summary"],
    },
  },
  {
    name: "request_evidence",
    description: "Ask the server for scan extracts you need to ground a rule. Server returns matching snippets.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, k: { type: "integer", default: 5 } },
      required: ["query"],
    },
  },
  {
    name: "finalise_fcg",
    description: "Hand the full proposed FCG (all rules + signature block) over for FCT vote.",
    input_schema: {
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

export const ucgTools: Anthropic.Messages.Tool[] = [
  {
    name: "propose_user_rule",
    description: "Stage a single add/modify/remove on the working UCG draft. Will be screened against the FCG.",
    input_schema: {
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
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "flag_fcg_conflict_for_amendment",
    description:
      "User wants something the FCG forbids. Emit an FCG amendment proposal request that the FCT can act on.",
    input_schema: {
      type: "object",
      properties: { fcgRuleId: { type: "string" }, reason: { type: "string" } },
      required: ["fcgRuleId","reason"],
    },
  },
  {
    name: "finalise_ucg",
    description: "Hand the full UCG draft to the Judge for compliance evaluation.",
    input_schema: {
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

export const judgeTool: Anthropic.Messages.Tool = {
  name: "respond_with_judgement",
  description: "Return the structured compliance verdict for the candidate UCG against the authoritative FCG.",
  input_schema: {
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

export const draftTool: Anthropic.Messages.Tool = {
  name: "respond_with_draft",
  description: "Return the final draft. Terminates the turn. Must be called exactly once and last.",
  input_schema: {
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
