import type { AIProvider, ProviderStreamOptions, StreamEvent, ToolCall } from "./types.js";

export type MockResponse =
  | { text: string; toolCalls?: ToolCall[] }
  | { toolCalls: ToolCall[]; text?: string };

/**
 * Scripted provider for tests and offline demos.
 * - script: array of responses; each stream() call consumes one.
 * - fn: dynamic responder receiving (messages, tools) — checked first.
 */
export class MockProvider implements AIProvider {
  id = "mock";
  label = "Mock (offline)";
  calls = 0;

  constructor(
    private script: MockResponse[] = [],
    private fn?: (messages: ProviderStreamOptions["messages"], tools: ProviderStreamOptions["tools"], call: number) => MockResponse | undefined
  ) {}

  async *stream(opts: ProviderStreamOptions): AsyncGenerator<StreamEvent, void, unknown> {
    this.calls++;
    const fromFn = this.fn?.(opts.messages, opts.tools, this.calls);
    const r = fromFn ?? this.script.shift() ?? { text: "(mock: no script left)" };
    if (r.text) yield { type: "text", text: r.text };
    if (r.toolCalls) {
      for (let i = 0; i < r.toolCalls.length; i++) {
        const tc = r.toolCalls[i];
        yield { type: "toolCall", toolCall: { ...tc, id: tc.id ?? `mock_${this.calls}_${i}` } };
      }
    }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
  }
}
