import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq, tmpProject } from "./helpers.mjs";

/** MCP stdio client: initialize -> tools/list -> tools/call -> notification responses. */
export async function test() {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "mcp-echo-server.mjs");

  const { McpStdioClient } = await import("../dist/core/mcp/client.js");
  const { createLogger } = await import("../dist/core/logger.js");
  const { McpManager } = await import("../dist/core/mcp/manager.js");
  const { EventBus } = await import("../dist/core/events.js");
  const logger = createLogger("silent");
  const events = new EventBus();

  // ---- raw client
  const client = new McpStdioClient("echo", { command: process.execPath, args: [serverPath] }, logger);
  await client.connect(10000);
  assert(client.isConnected(), "client connected");
  assertEq(client.serverInfo?.name, "echo-server", "serverInfo captured");

  const tools = await client.listTools();
  assertEq(tools.length, 1, "one tool advertised");
  assertEq(tools[0].name, "echo", "tool name");

  const out = await client.callTool("echo", { message: "hello mcp" });
  assertEq(out, "echo: hello mcp", "tool call round-trip");

  const err = await client.callTool("nope", {}).catch((e) => e);
  assert(err instanceof Error, "unknown tool rejects");
  client.close();

  // ---- manager: aggregate + findTool + list
  const dir = tmpProject();
  const { Harness } = await import("../dist/core/harness.js");
  const h = await Harness.create({
    projectDir: dir,
    loadModules: false,
    connectMcp: false,
    configOverrides: {
      logging: { level: "silent" },
      mcpServers: { echo: { transport: "stdio", command: process.execPath, args: [serverPath], timeoutMs: 10000 } },
    },
  });
  const mcp = new McpManager(h.config, logger, events);
  mcp.onToolsChanged(() => h.registerMcpTools());
  await mcp.connectAll(10000);

  assertEq(mcp.listServers().length, 1, "manager lists server");
  const agg = mcp.aggregate();
  assertEq(agg.length, 1, "aggregated tool");

  const found = mcp.findTool("mcp__echo__echo");
  assert(found && found.tool.name === "echo", "findTool by prefixed name");

  const call = await mcp.call("echo", "echo", { message: "via manager" });
  assertEq(call, "echo: via manager", "manager call");

  await mcp.close();
  await h.shutdown();
}
