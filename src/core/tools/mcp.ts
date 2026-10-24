import { errResult, schema, textResult, type Tool } from "./types.js";

export const mcpTools: Tool[] = [
  {
    name: "list_mcp",
    description: "List connected MCP servers and the tools each one exposes.",
    parameters: schema.obj({}, []),
    readOnly: true,
    run(_args, ctx) {
      const servers = ctx.mcp.listServers();
      if (!servers.length) {
        return textResult(
          "No MCP servers connected. Configure them under \"mcpServers\" in .noir/config.json or ~/.noir/config.json, e.g.\n" +
            '  "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } }'
        );
      }
      return textResult(servers.map((s) => `- ${s.name} (${s.transport}, ${s.connected ? "connected" : "down"}, ${s.tools} tools)`).join("\n"));
    },
  },
  {
    name: "call_mcp",
    description: "Call a tool on a connected MCP server directly by server name + tool name.",
    parameters: schema.obj({
      server: schema.str("MCP server name from config"),
      tool: schema.str("Tool name"),
      arguments: schema.any("Tool arguments object"),
    }, ["server", "tool"]),
    run(args, ctx) {
      const server = String(args.server ?? "");
      const tool = String(args.tool ?? "");
      const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
      return ctx.mcp
        .call(server, tool, toolArgs)
        .then((out) => textResult(out))
        .catch((err) => errResult((err as Error).message));
    },
  },
];
