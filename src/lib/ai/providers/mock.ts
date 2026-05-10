import type {
  CallToolOpts,
  ChatOpts,
  ChatResult,
  LLMProvider,
  ToolCall,
  ToolResult,
} from "./types";

/**
 * Mock provider — returns canned responses so the rest of the app (auth, RBAC,
 * voting, audit, schema, UI) can be exercised without any LLM API key. This is
 * the fallback when no real provider is configured for an agent role.
 *
 * Behaviour by role:
 *  - fcg-chat / ucg-chat: emit a single illustrative tool call and a friendly
 *    "this is a mock response" message.
 *  - judge:            return overall=pass with no rulings (i.e. UCG can commit).
 *  - draft:            return a holding-style draft with no actions.
 *  - sentiment:        neutral.
 *  - adherence:        all 1.0.
 *  - opportunity:      generic stub.
 *  - verifier:         everything verified.
 */

const MOCK_TEXT = "[mock LLM response — set ANTHROPIC_API_KEY or TOGETHER_API_KEY in your environment to use a real provider]";

function mockToolOutput(role: string, toolName: string): unknown {
  switch (toolName) {
    case "respond_with_judgement":
      return { overall: "pass", rulings: [] };
    case "respond_with_draft":
      return {
        type: "holding",
        channel: "email",
        language: "en-GB",
        subject: "Re: your message",
        body: "Thanks for your message. Acknowledging receipt; we'll come back with a substantive answer shortly. (Mock LLM response.)",
        citations: [],
        actions: [{ title: "Substantive response", type: "task", dueAt: null }],
        holdingRequired: true,
        holdingReason: "mock_llm_no_real_response",
        fcgWindowDeadline: null,
        noGoSubjectHit: false,
        researchTaskRequired: false,
      };
    case "respond_with_sentiment":
      return {
        classification: "neutral",
        confidence: 0.5,
        isAboutFirmHandling: false,
        evidenceSpans: [],
        trigger: null,
        shouldEscalate: false,
      };
    case "respond_with_adherence":
      // Shape must match `adherence` zod schema in @/lib/ai/schemas — the
      // eval harness (evals/) caught a stale `scoresByDimension` payload
      // here that no longer parsed.
      return {
        perDimension: {
          responseTime: { score: 1, verdict: "pass" },
          tone: { score: 1, verdict: "pass" },
          mandatoryPhrase: { score: 1, verdict: "pass" },
          prohibitedPhrase: { score: 1, verdict: "pass" },
          escalation: { score: 1, verdict: "pass" },
        },
        perRule: [],
        overall: 1,
      };
    case "respond_with_opportunity":
      // Mock provider returns a low-confidence call by default so the
      // detector's confidence floor discards it (no spam candidates in
      // demo). Set LLM_OPPORTUNITY=together:... or anthropic:... to get
      // real classifications.
      return {
        jurisdiction: "UK",
        serviceLine: "advisory",
        classification: "expansion",
        confidence: 0,
        rationale: "(mock — no real LLM configured for opportunity role)",
        signalQuotes: [],
        suggestedReviewerTeam: "Sales",
      };
    default:
      void role;
      return {};
  }
}

export const mockProvider: LLMProvider = {
  name: "mock",
  isConfigured: () => true,

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const toolCalls: ToolCall[] = [];
    if (opts.tools && opts.tools.length) {
      // Surface a single illustrative tool call so the chat UI shows "something happened".
      const t = opts.tools[0];
      toolCalls.push({ id: "mock-call-" + Date.now(), name: t.name, input: mockToolOutput(opts.role, t.name) });
    }
    return { message: MOCK_TEXT, toolCalls, usage: { inputTokens: 0, outputTokens: 0 }, modelRunId: "mock" };
  },

  async callTool<T>(opts: CallToolOpts): Promise<ToolResult<T>> {
    return {
      output: mockToolOutput(opts.role, opts.tool.name) as T,
      usage: { inputTokens: 0, outputTokens: 0 },
      modelRunId: "mock",
    };
  },
};
