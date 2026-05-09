/**
 * Provider-agnostic LLM interface.
 *
 * Each provider (anthropic, together, mock) implements `LLMProvider`. The
 * top-level `chat()` and `callTool()` in `lib/ai/client.ts` dispatch to the
 * provider bound to the current `AgentRole` (see `lib/ai/models.ts`).
 *
 * Tool input is JSON Schema in all providers — Anthropic calls the field
 * `input_schema`, OpenAI/Together calls it `parameters`. The provider
 * adapter handles the rename.
 */

export type AgentRole =
  | "fcg-chat"
  | "ucg-chat"
  | "judge"
  | "draft"
  | "verifier"
  | "adherence"
  | "sentiment"
  | "opportunity"
  | "meeting-paper"
  | "meeting-minutes";

export type SystemBlock = {
  text: string;
  /** Hint to providers that support prompt caching (Anthropic). Ignored elsewhere. */
  cache?: boolean;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ToolDef = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  schema: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type ChatResult = {
  message: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  modelRunId?: string;
};

export type ToolResult<T> = {
  output: T;
  usage?: Usage;
  modelRunId?: string;
};

export type ChatOpts = {
  role: AgentRole;
  system: SystemBlock[];
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Optional override of role default. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type CallToolOpts = {
  role: AgentRole;
  system: SystemBlock[];
  messages: ChatMessage[];
  tool: ToolDef;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export interface LLMProvider {
  readonly name: string;
  /** True if this provider has an API key set in the environment. */
  isConfigured(): boolean;
  chat(opts: ChatOpts & { model: string; maxTokens: number; temperature: number }): Promise<ChatResult>;
  callTool<T>(opts: CallToolOpts & { model: string; maxTokens: number; temperature: number }): Promise<ToolResult<T>>;
}
