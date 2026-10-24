import http from "node:http";
import { assert, assertEq, assertRejects } from "./helpers.mjs";

/**
 * Wire-protocol tests: run real OpenAI / Anthropic / Gemini SSE emulators on
 * localhost and drive the actual adapters against them — streaming, tool-call
 * assembly, multi-turn tool results, system prompt placement, error mapping,
 * malformed-SSE survival, CRLF framing, and aborts.
 */

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function sse(res, events, { crlf = false, chunkEvery = 1 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const payload = events.map((e) => (typeof e === "string" ? `data: ${e}` : `data: ${JSON.stringify(e)}`)).join(crlf ? "\r\n\r\n" : "\n\n") + (crlf ? "\r\n\r\n" : "\n\n");
  if (chunkEvery <= 1) {
    res.write(payload);
  } else {
    for (let i = 0; i < payload.length; i += chunkEvery) res.write(payload.slice(i, i + chunkEvery));
  }
  res.end();
}

async function collect(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const lastBody = { current: null };

/** ---------- OpenAI-compatible emulator ---------- */
async function openaiSuite() {
  const { server, port } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      lastBody.current = body;
      if (req.url.includes("/error")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      if (req.url.includes("/malformed")) {
        sse(res, ["{not json", JSON.stringify({ choices: [{ delta: { content: "still-alive" } }] }), "DONE"]);
        return;
      }
      const lastRole = body.messages?.[body.messages.length - 1]?.role;
      if (lastRole === "tool") {
        sse(res, [
          { choices: [{ delta: { content: "FINAL after tool" } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 5 } },
          "DONE",
        ]);
      } else {
        const mkTc = (entries) => ({ choices: [{ delta: { tool_calls: entries } }] });
        sse(res, [
          { choices: [{ delta: { content: "Hello " } }] },
          { choices: [{ delta: { content: "world" } }] },
          mkTc([
            { index: 0, id: "call_1", function: { name: "write_", arguments: '{"pa' } },
            { index: 1, id: "call_2", function: { name: "read_", arguments: "{" } },
          ]),
          mkTc([
            { index: 0, function: { name: "file", arguments: 'th":"x"}' } },
            { index: 1, function: { name: "file", arguments: '"path":"a.ts"}' } },
          ]),
          { choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 21 } },
          "DONE",
        ]);
      }
    });
  });

  const { OpenAICompatibleProvider } = await import("../dist/core/providers/openai.js");
  const p = new OpenAICompatibleProvider("test-openai", "Test", `http://127.0.0.1:${port}/v1`, "test-key");

  // 1. streaming text + parallel tool-call assembly across chunks
  const events = await collect(
    p.stream({ messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }], tools: [{ name: "write_file", description: "w", parameters: { type: "object" } }], model: "test-model" })
  );
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assertEq(text, "Hello world", "openai text assembled");
  const calls = events.filter((e) => e.type === "toolCall").map((e) => e.toolCall);
  assertEq(calls.length, 2, "openai two tool calls assembled");
  assertEq(calls[0].id, "call_1", "call id");
  assertEq(calls[0].name, "write_file", "name accumulated across chunks");
  assertEq(JSON.stringify(calls[0].arguments), '{"path":"x"}', "args assembled across chunks");
  assertEq(calls[1].name, "read_file", "second call name");
  assertEq(calls[1].arguments.path, "a.ts", "second call args");
  const usage = events.find((e) => e.type === "usage");
  assertEq(usage.usage.inputTokens, 9, "usage input");
  assertEq(usage.usage.outputTokens, 21, "usage output");

  // request shape
  assertEq(lastBody.current.model, "test-model", "model sent");
  assertEq(lastBody.current.stream, true, "stream true");
  assertEq(lastBody.current.messages[0].role, "system", "system kept as system");
  assertEq(lastBody.current.tools[0].function.name, "write_file", "tools as function defs");
  assertEq(lastBody.current.temperature, 0.4, "default temperature");

  // 2. multi-turn: tool result message converted to role:tool
  const events2 = await collect(
    p.stream({
      messages: [
        { role: "user", content: "write" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", arguments: { path: "x" } }] },
        { role: "tool", toolCallId: "call_1", name: "write_file", content: "Wrote 5 bytes" },
      ],
      tools: [],
      model: "m",
    })
  );
  assertEq(events2.filter((e) => e.type === "text").map((e) => e.text).join(""), "FINAL after tool", "post-tool turn");
  const sentMessages = lastBody.current.messages;
  assertEq(sentMessages[1].role, "assistant", "assistant with tool_calls");
  assertEq(sentMessages[1].tool_calls[0].id, "call_1", "tool_calls serialized");
  assertEq(sentMessages[2].role, "tool", "tool result as role:tool");
  assertEq(sentMessages[2].tool_call_id, "call_1", "tool_call_id");

  // 3. no tools -> no tools field
  await collect(p.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" }));
  assertEq(lastBody.current.tools, undefined, "tools omitted when empty");

  // 4. malformed SSE line does not kill the stream
  const events3 = await collect(p.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" }));
  // emulator only emits malformed for /malformed path — call via direct URL override
  const pMal = new OpenAICompatibleProvider("t", "T", `http://127.0.0.1:${port}/malformed`, "k");
  const events4 = await collect(pMal.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" }));
  const t4 = events4.filter((e) => e.type === "text").map((e) => e.text).join("");
  assertEq(t4, "still-alive", "survives malformed data line");

  // 5. error mapping
  const pErr = new OpenAICompatibleProvider("t", "T", `http://127.0.0.1:${port}/v1/error`, "k");
  await assertRejects(collect(pErr.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" })), "error mapping", "401");

  // 6. CRLF framing
  const { server: crlfServer, port: crlfPort } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => sse(res, [{ choices: [{ delta: { content: "crlf-ok" } }] }, "DONE"], { crlf: true }));
  });
  const pCrlf = new OpenAICompatibleProvider("t", "T", `http://127.0.0.1:${crlfPort}/v1`, "k");
  const events5 = await collect(pCrlf.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" }));
  assertEq(events5.filter((e) => e.type === "text").map((e) => e.text).join(""), "crlf-ok", "CRLF-framed SSE parsed");
  crlfServer.close();

  server.close();
}

/** ---------- Anthropic emulator ---------- */
async function anthropicSuite() {
  const { server, port } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      lastBody.current = body;
      if (req.url.includes("/error")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
        return;
      }
      const hasToolResult = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
      if (hasToolResult) {
        sse(res, [
          { type: "message_start", message: { usage: { input_tokens: 30 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "after tool_result" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ]);
      } else {
        sse(res, [
          { type: "message_start", message: { usage: { input_tokens: 10 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_time" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ci' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 22 } },
          { type: "message_stop" },
        ]);
      }
    });
  });

  const { AnthropicProvider } = await import("../dist/core/providers/anthropic.js");
  const p = new AnthropicProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test" });

  const events = await collect(
    p.stream({ messages: [{ role: "system", content: "sys prompt" }, { role: "user", content: "what time" }], tools: [{ name: "get_time", description: "t", parameters: { type: "object" } }], model: "claude-test" })
  );
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assertEq(text, "Hi!", "anthropic text");
  const call = events.find((e) => e.type === "toolCall")?.toolCall;
  assertEq(call.id, "toolu_1", "anthropic tool id");
  assertEq(call.name, "get_time", "anthropic tool name");
  assertEq(JSON.stringify(call.arguments), '{"city":"Paris"}', "anthropic json assembled from partials");

  // request shape: system top-level, tools with input_schema, version header sent
  assertEq(lastBody.current.system, "sys prompt", "system as top-level param");
  assertEq(lastBody.current.tools[0].input_schema.type, "object", "input_schema");
  assertEq(lastBody.current.max_tokens, 8192, "default max tokens");

  // multi-turn with isError
  await collect(
    p.stream({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "get_time", arguments: {} }] },
        { role: "tool", toolCallId: "toolu_1", name: "get_time", content: "boom", isError: true },
      ],
      tools: [],
      model: "claude-test",
    })
  );
  const resultBlock = lastBody.current.messages.find((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"))?.content.find((c) => c.type === "tool_result");
  assertEq(resultBlock.tool_use_id, "toolu_1", "tool_result id");
  assertEq(resultBlock.is_error, true, "is_error preserved");
  assertEq(resultBlock.content, "boom", "tool_result content");

  await assertRejects(
    collect(new AnthropicProvider({ baseUrl: `http://127.0.0.1:${port}/v1/error`, apiKey: "k" }).stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m" })),
    "anthropic error mapping",
    "400"
  );

  server.close();
}

/** ---------- Gemini emulator ---------- */
async function googleSuite() {
  const { server, port } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      lastBody.current = { body, url: req.url };
      if (req.url.includes("errormodel")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "server boom" } }));
        return;
      }
      const hasFnResponse = (body.contents ?? []).some((c) => c.parts?.some((p) => p.functionResponse));
      if (hasFnResponse) {
        sse(res, [{ candidates: [{ content: { parts: [{ text: "gemini after fn" }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6 } }]);
      } else {
        sse(res, [
          { candidates: [{ content: { parts: [{ text: "Gemini " }, { text: "reply" }] } }], usageMetadata: { promptTokenCount: 8 } },
          { candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { q: "cats" } } }] } }] },
        ]);
      }
    });
  });

  const { GoogleProvider } = await import("../dist/core/providers/google.js");
  const p = new GoogleProvider({ baseUrl: `http://127.0.0.1:${port}/v1beta`, apiKey: "g-key" });

  const events = await collect(
    p.stream({
      messages: [{ role: "system", content: "g-sys" }, { role: "user", content: "search cats" }],
      tools: [{ name: "search", description: "s", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
      model: "gemini-test",
    })
  );
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assertEq(text, "Gemini reply", "gemini text");
  const call = events.find((e) => e.type === "toolCall")?.toolCall;
  assertEq(call.name, "search", "gemini functionCall name");
  assertEq(call.arguments.q, "cats", "gemini args");
  assert(lastBody.current.url.includes("alt=sse"), "sse requested");
  assertEq(lastBody.current.body.systemInstruction.parts[0].text, "g-sys", "systemInstruction");
  const decl = lastBody.current.body.tools[0].functionDeclarations[0];
  assertEq(decl.parameters.type, "OBJECT", "schema type uppercase");
  assertEq(decl.parameters.properties.q.type, "STRING", "nested schema type uppercase");

  // multi-turn functionResponse
  await collect(
    p.stream({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "search", arguments: { q: "cats" } }] },
        { role: "tool", toolCallId: "g1", name: "search", content: "5 results" },
      ],
      tools: [],
      model: "gemini-test",
    })
  );
  const fnResp = lastBody.current.body.contents.find((c) => c.parts.some((x) => x.functionResponse))?.parts.find((x) => x.functionResponse).functionResponse;
  assertEq(fnResp.name, "search", "functionResponse name");
  assertEq(fnResp.response.result, "5 results", "functionResponse result");
  assertEq(lastBody.current.body.contents[1].role, "model", "assistant mapped to model role");

  await assertRejects(
    collect(new GoogleProvider({ baseUrl: `http://127.0.0.1:${port}/v1beta`, apiKey: "k" }).stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "errormodel" })),
    "gemini error mapping",
    "500"
  );

  server.close();
}

/** ---------- abort mid-stream ---------- */
async function abortSuite() {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "chunk1" } }] })}\n\n`);
    let i = 0;
    const timer = setInterval(() => {
      i++;
      if (i > 50) {
        clearInterval(timer);
        res.end();
        return;
      }
      try {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `chunk${i}` } }] })}\n\n`);
      } catch {
        clearInterval(timer);
      }
    }, 50);
    req.on("close", () => clearInterval(timer));
  });

  const { OpenAICompatibleProvider } = await import("../dist/core/providers/openai.js");
  const p = new OpenAICompatibleProvider("t", "T", `http://127.0.0.1:${port}/v1`, "k");
  const controller = new AbortController();
  const gen = p.stream({ messages: [{ role: "user", content: "x" }], tools: [], model: "m", signal: controller.signal });
  let gotFirst = false;
  let abortedCleanly = false;
  try {
    for await (const ev of gen) {
      if (ev.type === "text" && ev.text === "chunk1") {
        gotFirst = true;
        controller.abort();
      }
    }
  } catch (err) {
    abortedCleanly = /abort/i.test(err.message);
  }
  assert(gotFirst, "abort: received first chunk before aborting");
  assert(abortedCleanly, "abort: stream terminated on abort");
  server.close();
}

export async function test() {
  await openaiSuite();
  await anthropicSuite();
  await googleSuite();
  await abortSuite();
}
