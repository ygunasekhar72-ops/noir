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

const ANTHROPIC_VERSION = "2023-06-01";

type ContentBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

/** Anthropic Messages API provider. */
export class AnthropicProvider implements AIProvider {
  id = "anthropic";
  label = "Anthropic";
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  async *stream(opts: ProviderStreamOptions): AsyncIterable<StreamEvent> {
    const { messages, tools, model, signal, maxTokens, temperature } = opts;
    const system = messages
      .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 8192,
      temperature: temperature ?? 0.4,
      stream: true,
      messages: convertMessages(messages),
    };
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t: ToolDef) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const blocks = new Map<number, { type: "text" | "tool_use"; id?: string; name?: string; text: string; json: string }>();

    for await (const ev of sseLines(res.body, signal)) {
      if (ev === "DONE") break;
      const j = ev as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      if (j.type === "message_start" && j.message?.usage) {
        yield { type: "usage", usage: { inputTokens: j.message.usage.input_tokens, outputTokens: j.message.usage.output_tokens } };
      } else if (j.type === "content_block_start" && typeof j.index === "number") {
        blocks.set(j.index, {
          type: j.content_block?.type === "tool_use" ? "tool_use" : "text",
          id: j.content_block?.id,
          name: j.content_block?.name,
          text: "",
          json: "",
        });
      } else if (j.type === "content_block_delta" && typeof j.index === "number") {
        const block = blocks.get(j.index);
        if (block) {
          if (j.delta?.text) block.text += j.delta.text;
          if (j.delta?.partial_json) block.json += j.delta.partial_json;
        }
        if (j.delta?.text) yield { type: "text", text: j.delta.text };
      } else if (j.type === "content_block_stop" && typeof j.index === "number") {
        const block = blocks.get(j.index);
        if (block && block.type === "tool_use") {
          const toolCall: ToolCall = {
            id: block.id ?? `toolu_${j.index}_${Date.now()}`,
            name: block.name ?? "",
            arguments: safeParseJson(block.json),
          };
          if (toolCall.name) yield { type: "toolCall", toolCall };
        }
      } else if (j.type === "message_delta" && j.usage) {
        yield { type: "usage", usage: { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens } };
      }
    }
  }
}

/** Convert internal messages to Anthropic format (consecutive tool results merge into one user turn). */
function convertMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // passed separately
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : (m.content ?? "") });
    } else if (m.role === "tool") {
      // merge consecutive tool results into one user message
      const last = out[out.length - 1];
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else if (last && last.role === "user" && typeof last.content === "string" && last.content === "") {
        last.content = [block];
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  // strip empty assistant turns
  return out.filter((m) => m.role !== "assistant" || (Array.isArray(m.content) ? m.content.length > 0 : Boolean(m.content)));
}
