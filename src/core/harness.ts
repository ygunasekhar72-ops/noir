import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadConfig,
  projectNoirDir,
  ensureDir,
  deepMerge,
  saveProjectConfig,
  saveGlobalConfig,
  type Config,
} from "./config.js";
import { createLogger, type Logger, type LogLevel } from "./logger.js";
import { EventBus } from "./events.js";
import { createProvider, PROVIDER_PRESETS } from "./providers/index.js";
import type { AIProvider, JsonSchema } from "./providers/index.js";
import { MemoryStore } from "./memory/store.js";
import { Session, type Task } from "./session.js";
import { SkillManager } from "./skills/manager.js";
import { ModuleLoader, type HostContext } from "./modules/loader.js";
import { McpManager } from "./mcp/manager.js";
import { ToolRegistry, registerBuiltinTools, runShell, type ToolCtx } from "./tools/index.js";
import { Agent, type AgentEvent } from "./agent/agent.js";
import { Compactor } from "./agent/compaction.js";
import { SubagentRunner } from "./agent/subagents.js";
import { SwarmRunner } from "./agent/swarm.js";
import { registerCoreCommands } from "./commands.js";

export const NOIR_VERSION = "0.1.0";

export interface CommandDef {
  name: string;
  description: string;
  run: (args: string[], harness: Harness) => Promise<string> | string;
}

export interface PanelDef {
  id: string;
  title: string;
  render: (harness: Harness) => Promise<string> | string;
}

export interface HarnessOptions {
  projectDir?: string;
  configOverrides?: Partial<Config>;
  provider?: AIProvider;
  model?: string;
  loadModules?: boolean;
  connectMcp?: boolean;
  logLevel?: LogLevel;
}

/**
 * Harness — the wired-together core: provider, session, tools, memory,
 * skills, plugins, extensions, MCP, subagents, swarm, commands, panels.
 */
export class Harness {
  config: Config;
  logger: Logger;
  events = new EventBus();
  provider: AIProvider | null;
  providerError: string | null = null;
  projectDir: string;
  model: string;
  session: Session;
  tools = new ToolRegistry();
  commands = new Map<string, CommandDef>();
  panels = new Map<string, PanelDef>();
  memory: MemoryStore;
  skills: SkillManager;
  mcp: McpManager;
  subagents!: SubagentRunner;
  swarm!: SwarmRunner;
  private compactor: Compactor;
  private currentAbort: AbortController | null = null;
  private busy = false;
  modulesReady: Promise<void>;

  private constructor(opts: HarnessOptions, config: Config) {
    this.config = config;
    this.projectDir = resolve(opts.projectDir ?? process.cwd());
    this.logger = createLogger(config.logging?.level ?? opts.logLevel ?? "info");
    this.memory = new MemoryStore(this.projectDir);
    this.skills = new SkillManager(this.projectDir, this.logger);
    this.skills.load();
    this.mcp = new McpManager(this.config, this.logger, this.events);

    if (opts.provider) {
      this.provider = opts.provider;
    } else {
      try {
        this.provider = createProvider(this.config.provider, this.config);
        this.providerError = null;
      } catch (err) {
        this.provider = null;
        this.providerError = (err as Error).message;
      }
    }
    this.model = opts.model ?? this.config.model;

    // tool registry + MCP bridge
    registerBuiltinTools(this.tools);
    this.mcp.onToolsChanged(() => this.registerMcpTools());
    if (opts.connectMcp !== false) {
      void this.mcp.connectAll().catch((err) => this.logger.warn(`mcp connect: ${err.message}`));
    }

    // session
    this.session = new Session(this.projectDir, { provider: this.config.provider, model: this.model });
    ensureDir(projectNoirDir(this.projectDir));

    // agents
    const makeCtx = (session: Session): ToolCtx => this.makeCtx(session);
    this.subagents = new SubagentRunner({
      provider: this.provider ?? (null as unknown as AIProvider),
      model: this.model,
      config: this.config,
      registry: this.tools,
      memory: this.memory,
      skills: this.skills,
      logger: this.logger,
      events: this.events,
      projectDir: this.projectDir,
      makeCtx,
    });
    this.swarm = new SwarmRunner({
      provider: this.provider ?? (null as unknown as AIProvider),
      model: this.model,
      config: this.config,
      subagents: this.subagents,
      events: this.events,
      logger: this.logger,
      projectDir: this.projectDir,
    });
    this.compactor = new Compactor({
      provider: this.provider ?? (null as unknown as AIProvider),
      model: this.model,
      memory: this.memory,
      events: this.events,
      logger: this.logger,
    });

    if (opts.loadModules !== false) {
      this.modulesReady = this.loadModules();
    } else {
      this.modulesReady = Promise.resolve();
    }

    // core commands are always available in every surface (CLI, TUI, web app)
    registerCoreCommands(this);
  }

  static async create(opts: HarnessOptions = {}): Promise<Harness> {
    const projectDir = resolve(opts.projectDir ?? process.cwd());
    if (!existsSync(projectDir)) throw new Error(`project directory not found: ${projectDir}`);
    mkdirSync(projectNoirDir(projectDir), { recursive: true });
    const { config: loaded } = loadConfig(projectDir);
    const config = opts.configOverrides ? deepMerge(loaded, opts.configOverrides) : loaded;
    return new Harness(opts, config);
  }

  /** Plugins + extensions: loaded, setup() invoked, contributions collected. */
  private async loadModules(): Promise<void> {
    const host: HostContext["harness"] = {
      registerTool: (tool) => {
        this.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          readOnly: (tool as { readOnly?: boolean }).readOnly,
          run: async (args) => tool.run(args),
        });
      },
      registerCommand: (cmd) => {
        this.commands.set(cmd.name, {
          name: cmd.name,
          description: cmd.description,
          run: (args) => cmd.run(args, { harness: this }),
        });
      },
      registerPanel: (panel) => {
        this.panels.set(panel.id, { id: panel.id, title: panel.title, render: () => panel.render({ harness: this }) });
      },
      on: (event, listener) => this.events.on(event, listener as never),
      getConfig: () => this.config as unknown as Record<string, unknown>,
      log: (level, msg) => this.logger[level](msg),
      projectDir: this.projectDir,
      version: NOIR_VERSION,
    };

    for (const kind of ["plugin", "extension"] as const) {
      try {
        const loader = new ModuleLoader(this.projectDir, kind, this.logger);
        const mods = await loader.loadAll();
        for (const mod of mods) {
          loader.setup(mod, host);
          const contributions = (mod.module as { contributions?: { panels?: unknown[]; commands?: unknown[] } }).contributions;
          if (contributions) {
            const modAny = mod.module as Record<string, any>;
            // contributions: { commands: [...], panels: [...] }
            for (const cmd of contributions.commands ?? []) {
              const c = resolveContribution(cmd, modAny);
              if (c) host.registerCommand(c);
            }
            for (const panel of contributions.panels ?? []) {
              const p = resolveContribution(panel, modAny);
              if (p) host.registerPanel(p);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`${kind} loading failed: ${(err as Error).message}`);
      }
    }
  }

  registerMcpTools(): void {
    // remove stale mcp tools then re-register the current set
    for (const name of this.tools.names()) if (name.startsWith("mcp__")) this.tools.unregister(name);
    for (const { server, tool } of this.mcp.aggregate()) {
      const safeName = tool.name.replace(/[^A-Za-z0-9_-]/g, "_");
      const fullName = `mcp__${server}__${safeName}`;
      if (this.tools.has(fullName)) continue;
      this.tools.register({
        name: fullName,
        description: `[mcp/${server}] ${tool.description ?? tool.name}`,
        parameters: ((tool.inputSchema as JsonSchema) ?? { type: "object", properties: {} }),
        run: (args) => this.mcp.call(server, tool.name, args as Record<string, unknown>),
      });
    }
  }

  makeCtx(session: Session): ToolCtx {
    return {
      cwd: this.projectDir,
      config: this.config,
      logger: this.logger,
      events: this.events,
      memory: this.memory,
      session,
      skills: this.skills,
      mcp: this.mcp,
      subagents: this.subagents,
      swarm: this.swarm,
      taskBoard: {
        list: (): Task[] => session.taskBoard,
        add: (title: string): Task => {
          const t: Task = { id: String(session.taskBoard.length + 1), title, status: "todo" };
          session.taskBoard.push(t);
          session.save();
          return t;
        },
        update: (id: string, status: Task["status"]): Task | null => {
          const t = session.taskBoard.find((x) => x.id === id);
          if (!t) return null;
          t.status = status;
          session.save();
          return t;
        },
        clear: (): void => {
          session.taskBoard = [];
          session.save();
        },
      },
    };
  }

  isBusy(): boolean {
    return this.busy;
  }

  abort(): void {
    this.currentAbort?.abort();
  }

  /** One agent turn as a stream of events. Throws if busy or no provider. */
  async *chat(input: string): AsyncGenerator<AgentEvent, void, unknown> {
    if (this.busy) {
      yield { type: "note", text: "A turn is already running — abort it first." };
      yield { type: "done", reason: "end" };
      return;
    }
    if (!this.provider) {
      yield { type: "note", text: `No AI provider available: ${this.providerError ?? "not configured"}` };
      yield { type: "done", reason: "end" };
      return;
    }
    const controller = new AbortController();
    this.currentAbort = controller;
    this.busy = true;
    const agent = new Agent({
      provider: this.provider,
      model: this.model,
      session: this.session,
      registry: this.tools,
      config: this.config,
      memory: this.memory,
      skills: this.skills,
      events: this.events,
      logger: this.logger,
      makeCtx: (s) => this.makeCtx(s),
      signal: controller.signal,
    });
    try {
      for await (const ev of agent.run(input)) yield ev;
    } finally {
      this.busy = false;
      this.currentAbort = null;
    }
  }

  async compact(): Promise<{ ok: boolean; detail: string }> {
    if (!this.provider) return { ok: false, detail: this.providerError ?? "no provider" };
    try {
      const r = await this.compactor.compact(this.session);
      return { ok: true, detail: `snapshot: ${r.snapshotPath}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Streaming shell for the built-in terminal (TUI + mobile app). */
  runShell(command: string, onOutput: (chunk: string) => void, timeoutMs?: number): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    return runShell(command, {
      cwd: this.projectDir,
      timeoutMs: timeoutMs ?? this.config.shellTimeoutMs,
      onOutput,
    });
  }

  newSession(title?: string): Session {
    this.session = new Session(this.projectDir, { provider: this.config.provider, model: this.model, title });
    this.session.save();
    this.events.pub("session", { phase: "new", detail: this.session.id });
    return this.session;
  }

  resumeSession(id: string): Session | null {
    const s = Session.load(this.projectDir, id);
    if (!s) return null;
    this.session = s;
    this.events.pub("session", { phase: "resume", detail: id });
    return s;
  }

  listSessions() {
    return Session.list(this.projectDir);
  }

  setModel(model: string): void {
    this.model = model;
    this.config.model = model;
    this.session.model = model;
    this.session.save();
    this.rebuildAgentRunners();
  }

  async setProvider(providerId: string): Promise<string> {
    if (!PROVIDER_PRESETS[providerId] && providerId !== "custom") {
      throw new Error(`unknown provider "${providerId}". Known: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
    }
    const p = createProvider(providerId, { ...this.config, provider: providerId });
    this.provider = p;
    this.providerError = null;
    this.config.provider = providerId;
    const preset = PROVIDER_PRESETS[providerId];
    if (preset.models.length && !preset.models.includes(this.model)) {
      this.model = this.config.providers?.[providerId]?.model ?? preset.models[0];
      this.config.model = this.model;
    }
    this.rebuildAgentRunners();
    return this.model;
  }

  /** Recreate provider-bound runners (subagents, swarm, compactor) after model/provider changes. */
  private rebuildAgentRunners(): void {
    if (!this.provider) return;
    const makeCtx = (session: Session): ToolCtx => this.makeCtx(session);
    this.subagents = new SubagentRunner({
      provider: this.provider,
      model: this.model,
      config: this.config,
      registry: this.tools,
      memory: this.memory,
      skills: this.skills,
      logger: this.logger,
      events: this.events,
      projectDir: this.projectDir,
      makeCtx,
    });
    this.swarm = new SwarmRunner({
      provider: this.provider,
      model: this.model,
      config: this.config,
      subagents: this.subagents,
      events: this.events,
      logger: this.logger,
      projectDir: this.projectDir,
    });
    this.compactor = new Compactor({
      provider: this.provider,
      model: this.model,
      memory: this.memory,
      events: this.events,
      logger: this.logger,
    });
  }

  saveConfig(target: "project" | "global" = "project"): string {
    return target === "global" ? saveGlobalConfig(this.config) : saveProjectConfig(this.projectDir, this.config);
  }

  async shutdown(): Promise<void> {
    this.abort();
    await this.mcp.close().catch(() => undefined);
  }
}

/** contribution objects may be plain defs or `{ panel: {...} }` style objects. */
function resolveContribution(raw: unknown, modAny: Record<string, any>): any {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, any>;
  if (rec.command) return { ...rec.command, run: rec.command.run ?? modAny[rec.command.runFn ?? ""] };
  if (rec.panel) return { ...rec.panel, render: rec.panel.render ?? modAny[rec.panel.renderFn ?? ""] };
  return rec;
}
