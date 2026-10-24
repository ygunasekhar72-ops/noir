/**
 * Minimal stdio MCP echo server used by the MCP client test.
 * Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout.
 */
import { createInterface } from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32601) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "echo-server", version: "1.0.0" },
    });
  } else if (msg.method === "notifications/initialized" || msg.id === undefined) {
    // notification — no response
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a message back",
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    if (msg.params?.name === "echo") {
      reply(msg.id, { content: [{ type: "text", text: `echo: ${args.message ?? ""}` }], isError: false });
    } else {
      fail(msg.id, `unknown tool ${msg.params?.name}`, -32602);
    }
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else {
    fail(msg.id, `method not found: ${msg.method}`);
  }
});
