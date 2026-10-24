import type { Tool, ToolCtx, ToolResult } from "./types.js";
import type { ToolDef } from "../providers/types.js";

/** Registry of all agent tools: built-ins, plugin tools, and MCP tools. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      // later registration wins (plugins can override built-ins intentionally)
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Provider-facing definitions. */
  defs(filter?: (t: Tool) => boolean): ToolDef[] {
    return this.list()
      .filter((t) => (filter ? filter(t) : true))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Tool "${name}" is not registered. Available: ${this.names().join(", ")}`, isError: true };
    }
    try {
      const r = await tool.run(args, ctx);
      if (typeof r === "string") return { content: r };
      return r;
    } catch (err) {
      return { content: `Tool "${name}" failed: ${(err as Error).message}`, isError: true };
    }
  }
}
