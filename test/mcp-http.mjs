import http from "node:http";
import { assert, assertEq, assertRejects, tmpProject } from "./helpers.mjs";

/**
 * MCP HTTP transport battery against a local streamable-HTTP emulator:
 * handshake, tools/list, tools/call, session headers, timeouts, crashes.
 */
export async function test() {
  const state = { sessions: new Set() };
  let crash = false;

  const { server, port } = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (crash) {
          req.socket.destroy(); // simulate a crash without killing the emulator
          return;
        }
        const msg = JSON.parse(raw || "{}");
        if (msg.method === "initialize") {
          const sid = "sess-" + Math.random().toString(36).slice(2, 8);
          state.sessions.add(sid);
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sid });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "http-echo", version: "1.0.0" } } }));
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  { name: "http_echo", description: "Echo over http", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
                  { name: "slow", description: "Sleeps then answers", inputSchema: { type: "object" } },
                ],
              },
            })
          );
          return;
        }
        if (msg.method === "tools/call") {
          const name = msg.params?.name;
          if (name !== "http_echo" && name !== "slow") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } }));
            return;
          }
          if (name === "slow") {
            await new Promise((r) => setTimeout(r, 1500));
          }
          const text = name === "http_echo" ? `http-echo: ${msg.params.arguments?.msg ?? ""}` : "slow-done";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  const { McpHttpClient } = await import("../dist/core/mcp/client.js");
  const { createLogger } = await import("../dist/core/logger.js");
  const logger = createLogger("silent");

  const client = new McpHttpClient("http-echo", { transport: "http", url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 }, logger);
  await client.connect(5000);
  assert(client.isConnected(), "http client connected");

  const tools = await client.listTools();
  assertEq(tools.length, 2, "http tools listed");
  assertEq(tools[0].name, "http_echo", "tool name via http");

  const out = await client.callTool("http_echo", { msg: "over the wire" });
  assertEq(out, "http-echo: over the wire", "http tool call round trip");

  /* ---- timeout ---- */
  const slowClient = new McpHttpClient("http-echo", { transport: "http", url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 300 }, logger);
  await slowClient.connect(5000);
  await assertRejects(slowClient.callTool("slow", {}), "slow tool times out", "timed out");

  /* ---- crash handling ---- */
  crash = true;
  await assertRejects(client.callTool("http_echo", { msg: "x" }), "server crash rejects pending call");

  /* ---- manager integration with http transport ---- */
  crash = false;
  const { Harness } = await import("../dist/core/harness.js");
  const { McpManager } = await import("../dist/core/mcp/manager.js");
  const { EventBus } = await import("../dist/core/events.js");
  const dir = tmpProject("noir-mcp-http");
  const h = await Harness.create({
    projectDir: dir,
    loadModules: false,
    connectMcp: false,
    configOverrides: {
      logging: { level: "silent" },
      mcpServers: { httpserver: { transport: "http", url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 } },
    },
  });
  const mgr = new McpManager(h.config, logger, h.events);
  h.mcp = mgr; // wire the harness to THIS manager so registerMcpTools aggregates from it
  mgr.onToolsChanged(() => h.registerMcpTools());
  await mgr.connectAll(5000);
  h.registerMcpTools();

  assertEq(mgr.listServers().length, 1, "manager lists http server");
  assertEq(mgr.listServers()[0].transport, "http", "transport reported as http");
  const agg = mgr.aggregate();
  assertEq(agg.length, 2, "aggregated http tools");

  // registered into the tool registry as mcp__httpserver__http_echo
  const r = await h.tools.execute("mcp__httpserver__http_echo", { msg: "registry call" }, h.makeCtx(h.session));
  assert(!r.isError && r.content.includes("http-echo: registry call"), `mcp tool callable through registry: ${r.content}`);

  // error mapping: unknown method -> error surfaced
  await assertRejects(mgr.call("httpserver", "nope", {}), "unknown tool rejected");

  // config with enabled:false skipped
  const dir2 = tmpProject("noir-mcp-off");
  const h2 = await Harness.create({
    projectDir: dir2,
    loadModules: false,
    connectMcp: false,
    configOverrides: { logging: { level: "silent" }, mcpServers: { off: { transport: "http", url: `http://127.0.0.1:${port}/mcp`, enabled: false } } },
  });
  const mgr2 = new McpManager(h2.config, logger, h2.events);
  await mgr2.connectAll(2000);
  assertEq(mgr2.listServers().length, 0, "enabled:false server skipped");

  await mgr.close();
  await mgr2.close();
  server.close();
  await h.shutdown();
  await h2.shutdown();
}
