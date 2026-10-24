import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { MemoryStore } from "../memory/store.js";
import type { Session, Task } from "../session.js";
import type { SkillManager } from "../skills/manager.js";
import type { McpManager } from "../mcp/manager.js";
import type { JsonSchema, ToolDef } from "../providers/types.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult | string> | ToolResult | string;

export interface Tool extends ToolDef {
  readOnly?: boolean;
  run: ToolHandler;
}

export interface ToolCtx {
  cwd: string;
  config: Config;
  logger: Logger;
  events: EventBus;
  memory: MemoryStore;
  session: Session;
  skills: SkillManager;
  mcp: McpManager;
  /** subagent runner (late-bound to avoid cycles) */
  subagents: { run(type: string, task: string, opts?: { description?: string; model?: string; timeoutMs?: number }): Promise<{ result: string; error?: string }> };
  /** swarm runner (late-bound) */
  swarm: { run(objective: string, opts?: { workers?: number }): Promise<string> };
  taskBoard: {
    list(): Task[];
    add(title: string): Task;
    update(id: string, status: Task["status"]): Task | null;
    clear(): void;
  };
}

export function textResult(content: string): ToolResult {
  return { content };
}

export function errResult(message: string): ToolResult {
  return { content: message, isError: true };
}

export const schema = {
  obj: (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  }),
  str: (description: string): JsonSchema => ({ type: "string", description }),
  num: (description: string): JsonSchema => ({ type: "number", description }),
  bool: (description: string): JsonSchema => ({ type: "boolean", description }),
  any: (description: string): JsonSchema => ({ type: "object", description }),
};
