import {
  sseLines,
  safeParseJson,
  type AIProvider,
  type Message,
  type ProviderStreamOptions,
  type StreamEvent,
  type ToolCall,
  type ToolDef,
} from "./types.js";

/** OpenAI-compatible chat-completions provider (OpenAI, Groq, OpenRouter, DeepSeek, Mistral, Together, Ollama, LM Studio, ...). */
export class OpenAICompatibleProvider implements AIProvider {
  id: string;
  label: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(id: string, label: string, baseUrl: string, apiKey?: string) {
    this.id = id;
    this.label = label;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async *stream(opts: ProviderStreamOptions): AsyncIterable<StreamEvent> {
    const { messages, tools, model, signal, maxTokens, temperature } = opts;
    const body: Record<string, unknown> = {
      model,
      messages: convertMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: temperature ?? 0.4,
      max_tokens: maxTokens ?? 8192,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    } else {
      delete body.tools;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.label} API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const ev of sseLines(res.body, signal)) {
      if (ev === "DONE") break;
      const j = ev as {
        choices?: Array<{ delta?: { content?: string; tool_calls?: Array<ToolCallDelta> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = j.choices?.[0]?.delta;

      if (typeof delta?.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = pending.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(idx, slot);
        }
      }

      if (j.usage) {
        yield { type: "usage", usage: { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens } };
      }
    }

    const used = new Set<string>();
    for (const [, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      let id = slot.id || `call_${slot.name}_${used.size}`;
      while (used.has(id)) id = id + "_";
      used.add(id);
      const toolCall: ToolCall = {
        id,
        name: slot.name,
        arguments: safeParseJson(slot.args),
      };
      yield { type: "toolCall", toolCall };
    }
  }
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export function convertMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const tool_calls = m.toolCalls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
      out.push({ role: "assistant", content: m.content || null, ...(tool_calls?.length ? { tool_calls } : {}) });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}
