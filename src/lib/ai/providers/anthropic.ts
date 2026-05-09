import Anthropic from "@anthropic-ai/sdk";
import type {
  CallToolOpts,
  ChatMessage,
  ChatOpts,
  ChatResult,
  LLMProvider,
  SystemBlock,
  ToolCall,
  ToolDef,
  ToolResult,
} from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __anthropicClient: Anthropic | undefined;
}

function client(): Anthropic {
  if (!global.__anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    global.__anthropicClient = new Anthropic({
      apiKey,
      defaultHeaders: { "anthropic-beta": "extended-cache-ttl-2025-04-11" },
    });
  }
  return global.__anthropicClient;
}

function blocksToSystem(blocks: SystemBlock[]): Anthropic.Messages.TextBlockParam[] {
  return blocks.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
  }));
}

function toToolParam(t: ToolDef): Anthropic.Messages.Tool {
  return { name: t.name, description: t.description, input_schema: t.schema as Anthropic.Messages.Tool.InputSchema };
}

function toMessages(msgs: ChatMessage[]): Anthropic.Messages.MessageParam[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

function readUsage(msg: Anthropic.Messages.Message) {
  return {
    inputTokens: msg.usage?.input_tokens,
    outputTokens: msg.usage?.output_tokens,
    cacheReadTokens: msg.usage?.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? undefined,
  };
}

export const anthropicProvider: LLMProvider = {
  name: "anthropic",
  isConfigured: () => !!process.env.ANTHROPIC_API_KEY,

  async chat(opts: ChatOpts & { model: string; maxTokens: number; temperature: number }): Promise<ChatResult> {
    const msg = await client().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      system: blocksToSystem(opts.system),
      messages: toMessages(opts.messages),
      ...(opts.tools && opts.tools.length ? { tools: opts.tools.map(toToolParam) } : {}),
    });

    const text = msg.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    const toolCalls: ToolCall[] = msg.content
      .filter((c): c is Anthropic.Messages.ToolUseBlock => c.type === "tool_use")
      .map((c) => ({ id: c.id, name: c.name, input: c.input }));

    return { message: text, toolCalls, usage: readUsage(msg), modelRunId: msg.id };
  },

  async callTool<T>(
    opts: CallToolOpts & { model: string; maxTokens: number; temperature: number },
  ): Promise<ToolResult<T>> {
    const msg = await client().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      system: blocksToSystem(opts.system),
      messages: toMessages(opts.messages),
      tools: [toToolParam(opts.tool)],
      tool_choice: { type: "tool", name: opts.tool.name },
    });
    const block = msg.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use" || block.name !== opts.tool.name) {
      throw new Error(`anthropic.callTool: model did not invoke ${opts.tool.name}`);
    }
    return { output: block.input as T, usage: readUsage(msg), modelRunId: msg.id };
  },
};
