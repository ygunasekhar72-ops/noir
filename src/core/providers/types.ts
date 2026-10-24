/** Normalized internal message + provider tool types used across the harness. */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
};

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; toolCall: ToolCall }
  | { type: "usage"; usage: Usage };

export interface ProviderStreamOptions {
  messages: Message[];
  tools: ToolDef[];
  model: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface AIProvider {
  id: string;
  label: string;
  stream(opts: ProviderStreamOptions): AsyncIterable<StreamEvent>;
}

/** Helpers */

export function safeParseJson(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // some models wrap args in markdown fences
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1]) as Record<string, unknown>;
      } catch {
        /* fallthrough */
      }
    }
    return { _raw: raw };
  }
}

/** Concatenate SSE chunks split by a reader into "data:" events. */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown> | "DONE"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = sseChunkData(chunk);
        if (data === null) continue;
        if (data === "DONE") return "DONE";
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }
    const tail = sseChunkData(buffer);
    if (tail && tail !== "DONE") {
      try {
        yield JSON.parse(tail) as Record<string, unknown>;
      } catch {
        /* ignore malformed tail */
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function sseChunkText(chunk: string): string {
  return chunk
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
}

function sseChunkData(chunk: string): string | null {
  if (!chunk.includes("data:")) return null;
  const text = sseChunkText(chunk);
  if (!text) return null;
  if (text.trim() === "[DONE]") return "DONE";
  return text;
}
