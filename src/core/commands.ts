import type { Harness, CommandDef } from "./harness.js";
import { PROVIDER_PRESETS } from "./providers/index.js";
import { NOIR_VERSION } from "./harness.js";
import { listWebApps } from "./webapps.js";

/** Core commands, registered by the harness and used by TUI, mobile web app, and CLI. */
export function coreCommands(): CommandDef[] {
  return [
    {
      name: "help",
      description: "Show commands and keys",
      run: (_args, h) => {
        const cmds = [...h.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
        const lines = [
          "NOIR — commands",
          ...cmds.map((c) => `  /${c.name.padEnd(10)} ${c.description}`),
          "",
          "Any other text goes to the AI. Prefix with ! to run a shell command instead.",
          `version ${NOIR_VERSION}`,
        ];
        return lines.join("\n");
      },
    },
    {
      name: "model",
      description: "Show or set the model",
      run: (args, h) => {
        if (!args.length) {
          const preset = PROVIDER_PRESETS[h.config.provider];
          return `provider: ${h.config.provider} (${preset?.label ?? "custom"})\nmodel: ${h.model}\nsuggestions: ${preset?.models.join(", ") ?? "(set any)"}`;
        }
        h.setModel(args.join(" "));
        return `model set to ${h.model}`;
      },
    },
    {
      name: "provider",
      description: "Show or switch provider",
      run: async (args, h) => {
        if (!args.length) {
          return `current: ${h.config.provider}\navailable: ${Object.keys(PROVIDER_PRESETS).join(", ")}\nkeys are read from env (e.g. OPENAI_API_KEY) or config.providers.<id>.apiKey`;
        }
        try {
          const model = await h.setProvider(args[0]);
          return `provider set to ${args[0]} (model: ${model})`;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
    {
      name: "compact",
      description: "Compact the session now (memory is snapshotted first)",
      run: async (_args, h) => {
        const r = await h.compact();
        return r.ok ? `compacted. ${r.detail}` : `compaction failed: ${r.detail}`;
      },
    },
    {
      name: "clear",
      description: "Start a fresh session (keeps memory workspace)",
      run: (_args, h) => {
        h.newSession();
        return "new session started";
      },
    },
    {
      name: "sessions",
      description: "List sessions",
      run: (_args, h) => {
        const list = h.listSessions();
        if (!list.length) return "no saved sessions";
        return list
          .slice(0, 20)
          .map((s, i) => `${s.id === h.session.id ? "*" : " "} ${s.id}  ${String(s.tokens).padStart(7)} tok  ${s.title}`)
          .join("\n");
      },
    },
    {
      name: "resume",
      description: "Resume a session: /resume <id>",
      run: (args, h) => {
        if (!args.length) return "usage: /resume <session-id> (see /sessions)";
        const s = h.resumeSession(args[0]);
        return s ? `resumed ${s.id} (${s.messages.length} messages)` : `session ${args[0]} not found`;
      },
    },
    {
      name: "skills",
      description: "List skills",
      run: (_args, h) => {
        const all = h.skills.list();
        if (!all.length) return "no skills installed (add .noir/skills/<name>/SKILL.md)";
        return all.map((s) => `  ${s.id.padEnd(16)} [${s.source}] ${s.description}`).join("\n");
      },
    },
    {
      name: "skill",
      description: "Activate a skill: /skill <name>",
      run: async (args, h) => {
        if (!args.length) return "usage: /skill <name> (see /skills)";
        const tool = h.tools.get("use_skill");
        if (!tool) return "use_skill tool missing";
        const r = await tool.run({ name: args[0] }, h.makeCtx(h.session));
        return typeof r === "string" ? r : r.content;
      },
    },
    {
      name: "plugins",
      description: "List loaded plugins",
      run: (_args, h) => {
        const pluginTools = h.tools.list().filter((t) => !t.name.startsWith("mcp__") && !BUILTIN_TOOL_NAMES.has(t.name));
        if (!pluginTools.length) return "no plugins loaded (add .noir/plugins/<name>.js exporting setup(ctx))";
        return `plugin-contributed tools:\n${pluginTools.map((t) => `  ${t.name}: ${t.description.split("\n")[0]}`).join("\n")}`;
      },
    },
    {
      name: "extensions",
      description: "List loaded extensions (panels, commands)",
      run: (_args, h) => {
        const panels = [...h.panels.values()];
        const cmds = [...h.commands.values()].filter((c) => !CORE_COMMAND_NAMES.has(c.name));
        if (!panels.length && !cmds.length) return "no extensions loaded (add .noir/extensions/<name>.js)";
        const p = panels.length ? `panels:\n${panels.map((x) => `  ${x.id}: ${x.title}`).join("\n")}` : "";
        const c = cmds.length ? `commands:\n${cmds.map((x) => `  /${x.name}: ${x.description}`).join("\n")}` : "";
        return [p, c].filter(Boolean).join("\n");
      },
    },
    {
      name: "mcp",
      description: "MCP servers status",
      run: (_args, h) => {
        const servers = h.mcp.listServers();
        if (!servers.length) return `no MCP servers connected (configure "mcpServers" in config)`;
        return servers.map((s) => `  ${s.name} (${s.transport}) — ${s.connected ? "connected" : "down"}, ${s.tools} tools`).join("\n");
      },
    },
    {
      name: "memory",
      description: "Project memory: /memory [show|add <text>|snapshots]",
      run: (args, h) => {
        if (args[0] === "add") {
          const note = args.slice(1).join(" ").trim();
          if (!note) return "usage: /memory add <text>";
          const path = h.memory.appendNote(note, "notes");
          return `note added to ${path}`;
        }
        if (args[0] === "snapshots") {
          const snaps = h.memory.listSnapshots();
          return snaps.length ? snaps.map((s) => `  ${s.file} (${s.size}B)`).join("\n") : "no snapshots yet";
        }
        const notes = h.memory.readNotes();
        const facts = h.memory.readFacts();
        return `--- notes.md ---\n${notes || "(empty)"}\n--- facts.md ---\n${facts || "(empty)"}`;
      },
    },
    {
      name: "agent",
      description: "Run a subagent: /agent <type> <task>",
      run: async (args, h) => {
        if (args.length < 2) {
          return `usage: /agent <type> <task>\ntypes: ${h.subagents.listTypes().map((a) => a.name).join(", ")}`;
        }
        const type = args[0];
        const task = args.slice(1).join(" ");
        const r = await h.subagents.run(type, task, { timeoutMs: 600000 });
        return r.error ? `subagent failed: ${r.error}` : r.result;
      },
    },
    {
      name: "swarm",
      description: "Run a multi-agent swarm: /swarm <objective>",
      run: async (args, h) => {
        if (!args.length) return "usage: /swarm <objective>";
        return await h.swarm.run(args.join(" "), { workers: 4 });
      },
    },
    {
      name: "doctor",
      description: "Environment check",
      run: async (_args, h) => {
        const lines: string[] = [];
        lines.push(`noir ${NOIR_VERSION} — node ${process.version} — ${process.platform}/${process.arch}`);
        lines.push(`project: ${h.projectDir}`);
        lines.push(`provider: ${h.config.provider} / model: ${h.model} — ${h.provider ? "ready" : `ERROR: ${h.providerError}`}`);
        const envKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"];
        lines.push(`api keys in env: ${envKeys.filter((k) => process.env[k]).join(", ") || "none"}`);
        lines.push(`tools: ${h.tools.list().length} | skills: ${h.skills.list().length} | mcp: ${h.mcp.listServers().length} servers`);
        lines.push(`search provider: ${h.config.search.provider}`);
        lines.push(`memory workspace: ${h.memory.dir}`);
        try {
          const r = await h.runShell("echo ok", () => {}, 5000);
          lines.push(`shell: ${r.exitCode === 0 ? "ok" : "problem"}`);
        } catch {
          lines.push("shell: failed");
        }
        return lines.join("\n");
      },
    },
    {
      name: "apps",
      description: "List installed project web apps",
      run: (_args, h) => {
        const apps = listWebApps(h.projectDir);
        if (!apps.length) {
          return `no web apps installed. Drop one into .noir/webapps/<name>/ (see examples/noir-pad), then open http://127.0.0.1:${h.config.server.port}/apps/<name>/ in the mobile app.`;
        }
        return apps.map((a) => `  ${a} — http://127.0.0.1:${h.config.server.port}/apps/${a}/`).join("\n");
      },
    },
    {
      name: "exit",
      description: "Exit NOIR",
      run: () => "bye (close with ctrl+c in the TUI, or the /exit flow of your app)",
    },
  ];
}

export const CORE_COMMAND_NAMES = new Set(coreCommands().map((c) => c.name));

const BUILTIN_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "list_files", "search_files", "run_command",
  "web_search", "web_fetch", "save_memory", "read_memory", "list_snapshots",
  "list_skills", "use_skill", "task_board", "spawn_subagent", "swarm", "list_mcp", "call_mcp",
]);

export function registerCoreCommands(h: Harness): void {
  for (const cmd of coreCommands()) h.commands.set(cmd.name, cmd);
}
