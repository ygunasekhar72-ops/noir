import type { Tool } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { fsTools } from "./fs.js";
import { shellTools } from "./shell.js";
import { webTools } from "./web.js";
import { memoryTools } from "./memory.js";
import { skillTools, taskTools } from "./skills.js";
import { subagentTools, swarmTools } from "./agents.js";
import { mcpTools } from "./mcp.js";

export * from "./types.js";
export { ToolRegistry } from "./registry.js";
export { runShell } from "./shell.js";
export { fetchUrl } from "./web.js";

/** The built-in toolset — the "required tools" every real harness needs. */
export function builtinTools(): Tool[] {
  return [
    ...fsTools,
    ...shellTools,
    ...webTools,
    ...memoryTools,
    ...skillTools,
    ...taskTools,
    ...subagentTools,
    ...swarmTools,
    ...mcpTools,
  ];
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const t of builtinTools()) registry.register(t);
}
