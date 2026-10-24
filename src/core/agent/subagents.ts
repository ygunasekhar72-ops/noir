import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { MemoryStore } from "../memory/store.js";
import { Session } from "../session.js";
import type { SkillManager } from "../skills/manager.js";
import type { AIProvider } from "../providers/index.js";
import type { ToolRegistry } from "../tools/index.js";
import type { ToolCtx } from "../tools/index.js";
import { Agent } from "../agent/agent.js";

export interface AgentDef {
  name: string;
  description: string;
  tools: string[];
  system?: string;
  source: "builtin" | "project";
}

const ALL_TOOLS: string[] = [
  "read_file", "write_file", "edit_file", "list_files", "search_files", "run_command",
  "web_search", "web_fetch", "save_memory", "read_memory", "list_snapshots",
  "list_skills", "use_skill", "task_board", "spawn_subagent", "swarm", "list_mcp", "call_mcp",
];

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "explore",
    description: "Read-only scout: inspects files and search results fast without modifying anything. Ideal for codebase orientation.",
    tools: ["read_file", "list_files", "search_files", "web_search", "web_fetch", "task_board", "save_memory"],
    source: "builtin",
  },
  {
    name: "coder",
    description: "Implementation worker: edits files and runs commands to build and verify.",
    tools: ["read_file", "write_file", "edit_file", "list_files", "search_files", "run_command", "task_board", "save_memory"],
    source: "builtin",
  },
  {
    name: "researcher",
    description: "Web research worker: searches and reads pages, synthesizes findings with citations.",
    tools: ["web_search", "web_fetch", "read_file", "save_memory", "task_board"],
    source: "builtin",
  },
  {
    name: "writer",
    description: "Documentation worker: reads the codebase and writes/edits docs and prose.",
    tools: ["read_file", "write_file", "edit_file", "list_files", "search_files", "save_memory"],
    source: "builtin",
  },
  {
    name: "general",
    description: "General-purpose worker with the full toolset.",
    tools: ALL_TOOLS,
    source: "builtin",
  },
];

export interface SubagentDeps {
  provider: AIProvider;
  model: string;
  config: Config;
  registry: ToolRegistry;
  memory: MemoryStore;
  skills: SkillManager;
  logger: Logger;
  events: EventBus;
  projectDir: string;
  makeCtx: (session: Session) => ToolCtx;
}

export interface SubagentResult {
  result: string;
  error?: string;
  tokens: number;
  steps: number;
}

/** Spawns isolated subagent sessions with role-restricted toolsets. */
export class SubagentRunner {
  private agentDefs = new Map<string, AgentDef>();

  constructor(private deps: SubagentDeps) {
    this.loadDefs();
  }

  loadDefs(): void {
    this.agentDefs.clear();
    for (const a of BUILTIN_AGENTS) this.agentDefs.set(a.name, a);
    // custom agents: <project>/.noir/agents/<name>.json
    const dir = join(this.deps.projectDir, ".noir", "agents");
    if (existsSync(dir)) {
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const def = JSON.parse(readFileSync(join(dir, f), "utf8"));
          const name = (def.name ?? f.replace(/\.json$/, "")).toLowerCase();
          this.agentDefs.set(name, {
            name,
            description: def.description ?? "custom subagent",
            tools: Array.isArray(def.tools) && def.tools.length ? def.tools : ALL_TOOLS,
            system: def.system,
            source: "project",
          });
        }
      } catch {
        /* ignore malformed */
      }
    }
  }

  listTypes(): AgentDef[] {
    return [...this.agentDefs.values()];
  }

  getDef(name: string): AgentDef | undefined {
    return this.agentDefs.get(name.toLowerCase());
  }

  async run(type: string, task: string, opts: { description?: string; model?: string; timeoutMs?: number } = {}): Promise<SubagentResult> {
    const { provider, config, registry, memory, skills, logger, events, makeCtx } = this.deps;
    const def = this.getDef(type) ?? BUILTIN_AGENTS.find((a) => a.name === "general")!;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

    const session = Session.ephemeral(this.deps.projectDir);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const agent = new Agent({
      provider,
      model: opts.model ?? this.deps.model,
      session,
      registry,
      config,
      memory,
      skills,
      events,
      logger,
      makeCtx,
      allowedTools: def.tools,
      systemExtra: [
        def.system ?? "",
        `You are subagent "${def.name}" (${def.description}). Complete the assigned task fully, then stop. Report outcomes, key findings, file paths and caveats concisely at the end.`,
      ]
        .filter(Boolean)
        .join("\n"),
      signal: controller.signal,
      autoCompact: true,
    });

    let lastAssistant = "";
    let steps = 0;
    try {
      for await (const ev of agent.run(task)) {
        if (ev.type === "message" && ev.message.role === "assistant") {
          if (ev.message.content) lastAssistant = ev.message.content;
          steps++;
        }
      }
    } catch (err) {
      logger.warn(`subagent "${def.name}" failed: ${(err as Error).message}`);
      return { result: "", error: (err as Error).message, tokens: session.estimateTokens(), steps };
    } finally {
      clearTimeout(timer);
    }

    // persist the subagent transcript into the memory workspace (survives compaction)
    try {
      memory.saveSubagentTranscript(def.name, task, session.messages);
    } catch {
      /* best-effort */
    }

    return { result: lastAssistant || "(subagent returned no text)", tokens: session.estimateTokens(), steps };
  }
}
