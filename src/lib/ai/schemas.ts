/**
 * Zod + JSON Schema definitions shared by AI agents and persistence.
 * Each agent's `respond_with_X` tool uses the JSON Schema as its input_schema.
 */
import { z } from "zod";

// ─── Shared ────────────────────────────────────────────────────────────────

export const FCG_CATEGORIES = [
  "tone","response_time","salutation","signoff","signature",
  "mandatory_phrase","prohibited_phrase","escalation","regulatory","language",
] as const;

export const CHANNELS = ["email","slack","teams","letter","report","whatsapp_business","any"] as const;

// ─── FCG ──────────────────────────────────────────────────────────────────

export const fcgRule = z.object({
  externalId: z.string().min(1),
  category: z.enum(FCG_CATEGORIES),
  channel: z.enum(CHANNELS).default("any"),
  statement: z.string(),
  payload: z.record(z.unknown()).default({}),
  rationale: z.string().optional(),
  mandatory: z.boolean().default(false),
  priority: z.number().int().min(0).default(100),
  evidenceRefs: z.array(z.string()).default([]),
  channelOverrides: z.record(z.unknown()).optional(),
});
export type FCGRuleInput = z.infer<typeof fcgRule>;

export const proposeRuleChangeInput = z.object({
  action: z.enum(["add","modify","remove"]),
  rule: fcgRule,
  ruleIdToModify: z.string().optional(),
  rationale: z.string().optional(),
});
export type ProposeRuleChangeInput = z.infer<typeof proposeRuleChangeInput>;

export const finaliseFcgInput = z.object({
  rules: z.array(fcgRule),
  signatureBlock: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});
export type FinaliseFcgInput = z.infer<typeof finaliseFcgInput>;

// ─── UCG ──────────────────────────────────────────────────────────────────

export const ucgRule = fcgRule.extend({
  narrowsFcgRule: z.string().nullable().optional(),
});
export type UCGRuleInput = z.infer<typeof ucgRule>;

export const proposeUserRuleInput = z.object({
  action: z.enum(["add","modify","remove"]),
  rule: ucgRule,
  ruleIdToModify: z.string().optional(),
});

export const finaliseUcgInput = z.object({
  rules: z.array(ucgRule),
  signatureBlock: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});
export type FinaliseUcgInput = z.infer<typeof finaliseUcgInput>;

// ─── Judge ────────────────────────────────────────────────────────────────

export const ruling = z.object({
  ucgRuleId: z.string(),
  verdict: z.enum(["pass","fail","not_applicable"]),
  fcgClauseCited: z.string().nullable(),
  explanation: z.string().max(800),
  severity: z.enum(["blocking","advisory"]).nullable(),
  suggestedFix: z.string().nullable(),
});
export const judgement = z.object({
  overall: z.enum(["pass","fail","partial"]),
  rulings: z.array(ruling),
});
export type Judgement = z.infer<typeof judgement>;

// ─── Draft ────────────────────────────────────────────────────────────────

export const action = z.object({
  title: z.string(),
  detail: z.string().optional(),
  type: z.enum(["task","calendar","followup","research"]).default("task"),
  dueAt: z.string().nullable().optional(),
});
export const citation = z.object({
  marker: z.string(),
  source: z.string(),
  locator: z.string().optional(),
  claim: z.string(),
});
export const draftOutput = z.object({
  type: z.enum(["substantive","holding","technical","holding_research"]),
  channel: z.enum(CHANNELS),
  language: z.string().default("en-GB"),
  subject: z.string().nullable().optional(),
  body: z.string(),
  citations: z.array(citation).default([]),
  actions: z.array(action).default([]),
  holdingRequired: z.boolean().default(false),
  holdingReason: z.string().nullable().optional(),
  fcgWindowDeadline: z.string().nullable().optional(),
  noGoSubjectHit: z.boolean().default(false),
  researchTaskRequired: z.boolean().default(false),
});
export type DraftOutput = z.infer<typeof draftOutput>;

// ─── Sentiment / Adherence / Opportunity (Phase 2) ────────────────────────

export const sentiment = z.object({
  classification: z.enum(["extreme_negative","extreme_positive","neutral"]),
  confidence: z.number().min(0).max(1),
  isAboutFirmHandling: z.boolean(),
  evidenceSpans: z.array(z.object({ text: z.string(), start: z.number().optional(), end: z.number().optional() })).default([]),
  trigger: z.string().nullable(),
  shouldEscalate: z.boolean(),
});
export type Sentiment = z.infer<typeof sentiment>;

export const ADHERENCE_DIMENSIONS = [
  "responseTime","tone","mandatoryPhrase","prohibitedPhrase","escalation",
] as const;
export type AdherenceDimension = (typeof ADHERENCE_DIMENSIONS)[number];

export const adherenceDimensionScore = z.object({
  score: z.number().min(0).max(1).nullable(),
  verdict: z.enum(["pass", "partial", "fail", "not_applicable"]),
  evidence: z.string().max(400).optional(),
});

export const adherenceRuleFinding = z.object({
  ruleExternalId: z.string(),
  source: z.enum(["fcg", "ucg"]),
  verdict: z.enum(["pass", "fail"]),
  explanation: z.string().max(400),
});

export const adherence = z.object({
  perDimension: z.object({
    responseTime: adherenceDimensionScore,
    tone: adherenceDimensionScore,
    mandatoryPhrase: adherenceDimensionScore,
    prohibitedPhrase: adherenceDimensionScore,
    escalation: adherenceDimensionScore,
  }),
  perRule: z.array(adherenceRuleFinding).default([]),
  overall: z.number().min(0).max(1),
});
export type Adherence = z.infer<typeof adherence>;

export const opportunity = z.object({
  jurisdiction: z.string(),
  serviceLine: z.string(),
  classification: z.enum(["new_engagement","expansion","renewal","cross_sell","referral"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  signalQuotes: z.array(z.string()).default([]),
  suggestedReviewerTeam: z.string(),
});
export type Opportunity = z.infer<typeof opportunity>;

// ─── Meeting paper (PRD §7.4) ─────────────────────────────────────────────

export const agendaItem = z.object({
  item: z.string().min(1).max(200),
  durationMin: z.number().int().min(1).max(240).nullable().optional(),
  owner: z.string().max(120).nullable().optional(),
});
export type AgendaItem = z.infer<typeof agendaItem>;

export const meetingPaper = z.object({
  agenda: z.array(agendaItem).min(1).max(20),
  paper: z.string().min(1),
  openQuestions: z.array(z.string().max(400)).default([]),
});
export type MeetingPaper = z.infer<typeof meetingPaper>;
