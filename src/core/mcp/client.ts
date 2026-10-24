import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { Logger } from "../logger.js";
import type { McpServerConfig } from "../config.js";

/**
 * Cross-platform spawn for MCP servers.
 * - Unix/Android (Termux): direct spawn, no shell.
 * - Windows: only shell-through when the command is a .cmd/.bat or has no
 *   extension (npx, etc.). Real executables (node, python) spawn directly,
 *   which keeps quoted paths with spaces safe.
 */
function spawnCommand(cmd: string, args: string[], opts: { env?: Record<string, string> }): ChildProcess {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const needsShell =
    process.platform === "win32" && (/\.(cmd|bat)$/i.test(cmd) || !/\.[A-Za-z]+$/.test(cmd));
  if (needsShell) {
    const quote = (s: string): string => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    return spawn([quote(cmd), ...args.map(quote)].join(" "), {
      shell: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: false,
    });
  }
  return spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Minimal, dependency-free MCP (Model Context Protocol) JSON-RPC 2.0 client. */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export class McpStdioClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private connected = false;
  serverInfo: { name?: string; version?: string } = {};
  capabilities: Record<string, unknown> = {};

  constructor(
    private name: string,
    private cfg: McpServerConfig,
    private logger: Logger
  ) {
    super();
  }

  async connect(timeoutMs = 15000): Promise<void> {
    if (!this.cfg.command) throw new Error(`MCP server "${this.name}": stdio transport requires "command"`);
    const cmd = this.cfg.command;
    const args = this.cfg.args ?? [];
    this.proc = spawnCommand(cmd, args, { ...this.cfg.env });

    this.proc.on("error", (err) => {
      this.logger.error(`MCP "${this.name}" spawn error: ${err.message}`);
      this.failAllPending(err);
    });
    this.proc.on("exit", (code) => {
      if (this.connected) {
        this.logger.warn(`MCP "${this.name}" exited (code ${code}).`);
        this.connected = false;
        this.failAllPending(new Error(`MCP server "${this.name}" exited`));
      }
    });

    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    if (stdout) {
      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => this.handleLine(line));
    }
    if (stderr) {
      const rl = createInterface({ input: stderr });
      rl.on("line", (line) => {
        if (line.trim()) this.logger.debug(`MCP "${this.name}" stderr: ${line.slice(0, 300)}`);
      });
    }

    // initialize handshake
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "noir-harness", version: "0.1.0" },
    }, timeoutMs);
    this.serverInfo = (init.serverInfo as any) ?? {};
    this.capabilities = (init.capabilities as any) ?? {};
    this.notify("notifications/initialized", {});
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected && !this.proc?.killed;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.logger.debug(`MCP "${this.name}": non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (msg.method && typeof msg.method === "string") {
      // server request or notification
      if (msg.id !== undefined && msg.id !== null) {
        // respond to known server requests
        if (msg.method === "ping") this.respond(msg.id, {});
        else if (msg.method === "roots/list") this.respond(msg.id, { roots: [] });
        else this.respond(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
      } else if (msg.method === "notifications/tools/list_changed") {
        this.emit("toolsChanged");
      }
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${this.name}: ${msg.error.message ?? "MCP error"}`));
      else p.resolve(msg.result);
    }
  }

  private respond(id: any, result: unknown, error?: { code: number; message: string }): void {
    this.write({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin || this.proc.killed) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin || this.proc.killed) {
        reject(new Error(`MCP "${this.name}" is not connected`));
        return;
      }
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.name}" request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(req);
    });
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.request("tools/list", {}, this.cfg.timeoutMs ?? 20000);
    const tools = (res?.tools ?? []) as McpToolInfo[];
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      this.cfg.timeoutMs ?? 60000
    );
    return mcpContentToText(res);
  }

  close(): void {
    this.connected = false;
    this.failAllPending(new Error("closed"));
    try {
      this.proc?.stdin?.end();
      this.proc?.kill();
    } catch {
      /* noop */
    }
    this.proc = null;
  }
}

/** Basic streamable-HTTP MCP transport (single POST per request, SSE-aware responses). */
export class McpHttpClient {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(
    private name: string,
    private cfg: McpServerConfig,
    private logger: Logger
  ) {}

  isConnected(): boolean {
    return Boolean(this.cfg.url);
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    if (!this.cfg.url) throw new Error(`MCP server "${this.name}": http transport requires "url"`);
    const id = this.nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP "${this.name}" http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const body = await res.text();
      for (const block of body.split("\n\n")) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          const j = JSON.parse(data);
          if (j.id === id) {
            if (j.error) throw new Error(j.error.message ?? "MCP error");
            return j.result;
          }
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
        }
      }
      throw new Error(`MCP "${this.name}": no matching SSE response`);
    }
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(j.error.message ?? "MCP error");
    return j.result;
  }

  async connect(_timeoutMs = 15000): Promise<void> {
    const init = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "noir-harness", version: "0.1.0" },
    });
    this.logger.debug(`MCP "${this.name}" (http) initialized: ${init?.serverInfo?.name ?? "?"}`);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.rpc("tools/list", {}, this.cfg.timeoutMs ?? 20000);
    return (res?.tools ?? []) as McpToolInfo[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.rpc("tools/call", { name, arguments: args ?? {} }, this.cfg.timeoutMs ?? 60000);
    return mcpContentToText(res);
  }

  close(): void {
    /* nothing persistent */
  }
}

export function mcpContentToText(result: any): string {
  if (result?.isError) {
    const text = (result.content ?? []).map((c: any) => c.text ?? JSON.stringify(c)).join("\n");
    throw new Error(text || "MCP tool returned an error");
  }
  const content = result?.content ?? [];
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else parts.push(JSON.stringify(c));
  }
  return parts.join("\n") || JSON.stringify(result ?? {});
}
