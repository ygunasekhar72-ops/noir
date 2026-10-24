import {
  sseLines,
  type AIProvider,
  type JsonSchema,
  type Message,
  type ProviderStreamOptions,
  type StreamEvent,
  type ToolCall,
} from "./types.js";

type GPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } } | { functionResponse: { name: string; response: { result: unknown } } };
type GContent = { role: "user" | "model"; parts: GPart[] };

/** Google Gemini provider (generativelanguage REST, SSE streaming). */
export class GoogleProvider implements AIProvider {
  id = "google";
  label = "Google Gemini";
  private apiKey?: string;
  private baseUrl: string;

  constructor(opts: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  async *stream(opts: ProviderStreamOptions): AsyncIterable<StreamEvent> {
    const { messages, tools, model, signal, maxTokens, temperature } = opts;
    const system = messages
      .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const body: Record<string, unknown> = {
      contents: convertContents(messages),
      generationConfig: {
        temperature: temperature ?? 0.4,
        maxOutputTokens: maxTokens ?? 8192,
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map((t) => convertSchema(t)) }];
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "x-goog-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 500)}`);
    }

    let callIdx = 0;
    for await (const ev of sseLines(res.body, signal)) {
      if (ev === "DONE") break;
      const j = ev as {
        candidates?: Array<{ content?: { parts?: GPart[] } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      for (const part of j.candidates?.[0]?.content?.parts ?? []) {
        if ("text" in part && typeof part.text === "string" && part.text) {
          yield { type: "text", text: part.text };
        }
        if ("functionCall" in part && part.functionCall?.name) {
          const toolCall: ToolCall = {
            id: `gcall_${callIdx++}_${Date.now()}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
          };
          yield { type: "toolCall", toolCall };
        }
      }
      if (j.usageMetadata) {
        yield {
          type: "usage",
          usage: { inputTokens: j.usageMetadata.promptTokenCount, outputTokens: j.usageMetadata.candidatesTokenCount },
        };
      }
    }
  }
}

/** Convert internal messages to Gemini contents; consecutive tool results merge into one user turn. */
function convertContents(messages: Message[]): GContent[] {
  const out: GContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // passed separately
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: GPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
      if (parts.length) out.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const part: GPart = { functionResponse: { name: m.name, response: { result: m.content } } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts.every((p) => "functionResponse" in p)) {
        last.parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
    }
  }
  return out;
}

/** Google expects uppercase type names in the REST schema. */
function convertSchema(tool: { name: string; description: string; parameters: JsonSchema }): Record<string, unknown> {
  const conv = (s: JsonSchema | undefined): Record<string, unknown> => {
    if (!s) return {};
    const out: Record<string, unknown> = {};
    if (s.description) out.description = s.description;
    if (s.type) out.type = String(s.type).toUpperCase();
    if (s.enum) out.enum = s.enum;
    if (s.required) out.required = s.required;
    if (s.properties) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties)) props[k] = conv(v as JsonSchema);
      out.properties = props;
    }
    if (s.items) out.items = conv(s.items as JsonSchema);
    return out;
  };
  return {
    name: tool.name,
    description: tool.description,
    parameters: conv(tool.parameters),
  };
}
