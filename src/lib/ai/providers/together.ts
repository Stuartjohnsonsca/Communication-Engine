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

/**
 * Together AI provider — uses the OpenAI-compatible Chat Completions API
 * at `https://api.together.xyz/v1/chat/completions`.
 *
 * Tool calling: Together exposes OpenAI-style `tools` + `tool_choice`. We
 * translate JSON-Schema tool defs (which Anthropic calls `input_schema`,
 * OpenAI calls `parameters`).
 *
 * Prompt caching: Together does NOT support Anthropic-style `cache_control`
 * on Llama models. The `cache: true` hint on system blocks is ignored.
 *
 * Defaults assume Llama 3.3 70B Instruct Turbo unless the model is
 * explicitly overridden in `models.ts`.
 */

const ENDPOINT = "https://api.together.xyz/v1/chat/completions";

type ChatChoice = {
  message: {
    role: string;
    content?: string | null;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  };
};
type ChatResponse = {
  id?: string;
  choices: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function systemText(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

function toOpenAIMessages(system: SystemBlock[], msgs: ChatMessage[]): { role: string; content: string }[] {
  return [{ role: "system", content: systemText(system) }, ...msgs.map((m) => ({ role: m.role, content: m.content }))];
}

function toOpenAITool(t: ToolDef) {
  return {
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.schema },
  };
}

async function call(body: Record<string, unknown>): Promise<ChatResponse> {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) throw new Error("TOGETHER_API_KEY not set");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Together API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as ChatResponse;
}

function readToolCalls(choice: ChatChoice): ToolCall[] {
  const out: ToolCall[] = [];
  for (const tc of choice.message.tool_calls ?? []) {
    let parsed: unknown = {};
    try {
      parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      // Leave as raw string if Llama returns invalid JSON; the caller can decide.
      parsed = { _raw: tc.function.arguments };
    }
    out.push({ id: tc.id, name: tc.function.name, input: parsed });
  }
  return out;
}

function readUsage(resp: ChatResponse) {
  return {
    inputTokens: resp.usage?.prompt_tokens,
    outputTokens: resp.usage?.completion_tokens,
  };
}

export const togetherProvider: LLMProvider = {
  name: "together",
  isConfigured: () => !!process.env.TOGETHER_API_KEY,

  async chat(opts: ChatOpts & { model: string; maxTokens: number; temperature: number }): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: toOpenAIMessages(opts.system, opts.messages),
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };
    if (opts.tools && opts.tools.length) body.tools = opts.tools.map(toOpenAITool);

    const resp = await call(body);
    const choice = resp.choices[0];
    return {
      message: (choice.message.content ?? "").trim(),
      toolCalls: readToolCalls(choice),
      usage: readUsage(resp),
      modelRunId: resp.id,
    };
  },

  async callTool<T>(
    opts: CallToolOpts & { model: string; maxTokens: number; temperature: number },
  ): Promise<ToolResult<T>> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: toOpenAIMessages(opts.system, opts.messages),
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      tools: [toOpenAITool(opts.tool)],
      tool_choice: { type: "function", function: { name: opts.tool.name } },
    };
    const resp = await call(body);
    const choice = resp.choices[0];
    const tcs = readToolCalls(choice);
    const tc = tcs.find((c) => c.name === opts.tool.name);
    if (!tc) {
      throw new Error(
        `together.callTool: model did not invoke ${opts.tool.name}. Got tool_calls: ${tcs.map((c) => c.name).join(",") || "(none)"}; content="${choice.message.content?.slice(0, 200) ?? ""}"`,
      );
    }
    return { output: tc.input as T, usage: readUsage(resp), modelRunId: resp.id };
  },
};
