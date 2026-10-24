import type { Config, McpServerConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import { McpHttpClient, McpStdioClient, type McpToolInfo } from "./client.js";

export interface ConnectedServer {
  name: string;
  transport: "stdio" | "http";
  client: { listTools(): Promise<McpToolInfo[]>; callTool(name: string, args: Record<string, unknown>): Promise<string>; close(): void; isConnected(): boolean };
  tools: McpToolInfo[];
}

/**
 * Loads MCP servers from config, connects (stdio/http), aggregates their tools,
 * and exposes them as native agent tools (mcp__<server>__<tool>).
 */
export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private connecting: Promise<void> | null = null;
  private onChange: ((tools: Array<{ server: string; tool: McpToolInfo }>) => void) | null = null;

  constructor(
    private config: Config,
    private logger: Logger,
    private events: EventBus
  ) {}

  /** Called by the harness whenever the aggregated tool set changes (re-registers tools). */
  onToolsChanged(cb: (tools: Array<{ server: string; tool: McpToolInfo }>) => void): void {
    this.onChange = cb;
  }

  async connectAll(timeoutMs = 15000): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const entries = Object.entries(this.config.mcpServers ?? {}).filter(
        ([, cfg]) => cfg?.enabled !== false && (cfg.command || cfg.url)
      );
      await Promise.all(
        entries.map(async ([name, cfg]) => {
          try {
            await this.connectServer(name, cfg, timeoutMs);
          } catch (err) {
            this.logger.warn(`MCP server "${name}" failed to connect: ${(err as Error).message}`);
            this.events.pub("log", { message: `MCP "${name}" unavailable: ${(err as Error).message}` });
          }
        })
      );
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectServer(name: string, cfg: McpServerConfig, timeoutMs: number): Promise<void> {
    const transport: "stdio" | "http" = cfg.transport ?? (cfg.url ? "http" : "stdio");
    const client =
      transport === "http"
        ? new McpHttpClient(name, cfg, this.logger)
        : new McpStdioClient(name, cfg, this.logger);

    await client.connect(timeoutMs);
    const tools = await client.listTools();

    const server: ConnectedServer = { name, transport, client, tools };
    this.servers.set(name, server);

    // react to tool list changes on stdio servers
    const anyClient = client as unknown as { on?: (ev: string, cb: () => void) => void };
    anyClient.on?.("toolsChanged", async () => {
      try {
        server.tools = await client.listTools();
        this.logger.info(`MCP "${name}" tools changed (${server.tools.length} tools)`);
        this.notify();
      } catch {
        /* ignore */
      }
    });

    this.logger.info(`MCP "${name}" connected — ${tools.length} tools`);
    this.notify();
  }

  private notify(): void {
    this.onChange?.(this.aggregate());
  }

  aggregate(): Array<{ server: string; tool: McpToolInfo }> {
    const out: Array<{ server: string; tool: McpToolInfo }> = [];
    for (const s of this.servers.values()) {
      for (const t of s.tools) out.push({ server: s.name, tool: t });
    }
    return out;
  }

  listServers(): Array<{ name: string; transport: string; connected: boolean; tools: number }> {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      transport: s.transport,
      connected: s.client.isConnected(),
      tools: s.tools.length,
    }));
  }

  getServer(name: string): ConnectedServer | undefined {
    return this.servers.get(name);
  }

  findTool(prefixedName: string): { server: ConnectedServer; tool: McpToolInfo } | null {
    const m = prefixedName.match(/^mcp__(.+?)__(.+)$/);
    if (!m) return null;
    const server = this.servers.get(m[1]);
    if (!server) return null;
    const tool = server.tools.find((t) => t.name === m[2]);
    if (!tool) return null;
    return { server, tool };
  }

  async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server "${serverName}" is not connected.`);
    return server.client.callTool(toolName, args);
  }

  async close(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        s.client.close();
      } catch {
        /* noop */
      }
    }
    this.servers.clear();
  }
}
