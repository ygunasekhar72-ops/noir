import { Harness, NOIR_VERSION, type HarnessOptions } from "./core/harness.js";
import { registerCoreCommands } from "./core/commands.js";
import { PROVIDER_PRESETS } from "./core/providers/index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** ------------------------------------------------------------------ *
 * arg parsing
 * ------------------------------------------------------------------ */

interface CliArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-" && !/^-?\d+(\.\d+)?$/.test(a)) {
      const key = a.replace(/^-+/, "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positionals.push(a);
      i += 1;
    }
  }
  const command = positionals.shift() ?? "tui";
  return { command, positionals, flags };
}

const USAGE = `NOIR — the monochrome agent harness for terminal & mobile.

usage: noir [command] [args] [flags]

commands:
  noir                       interactive TUI (default)
  noir serve [--host H] [--port P]   start the mobile app server (PWA)
  noir run "<task>"          one-shot agent task, non-interactive
  noir chat                  plain REPL (lightweight terminal)
  noir swarm "<objective>"   multi-agent swarm, headless
  noir agent <type> "<task>" run one subagent headless
  noir sessions              list saved sessions
  noir skills | plugins | extensions | mcp | tools   registries
  noir memory [show|snapshots]
  noir models                list model suggestions per provider
  noir doctor                environment check
  noir init                  write a sample .noir/config.json
  noir version | help

flags:
  -m, --model <id>       select model
  -p, --provider <id>    select provider (${Object.keys(PROVIDER_PRESETS).join(", ")})
  -C, --project <dir>    project directory (default: cwd)
      --json             JSONL event stream (run)
      --host, --port     server bind (serve)
  -q, --quiet            log level silent

API keys: env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ...)
or config: ~/.noir/config.json { "providers": { "openai": { "apiKey": "..." } } }`;

async function buildHarness(flags: Record<string, string | boolean>): Promise<Harness> {
  const opts: HarnessOptions = {
    projectDir: (flags.project ?? flags.C) as string | undefined,
    logLevel: flags.quiet || flags.q ? "silent" : undefined,
  };
  if (flags.provider || flags.p) opts.configOverrides = { provider: String(flags.provider ?? flags.p) };
  const h = await Harness.create(opts);
  registerCoreCommands(h);
  if (flags.model || flags.m) h.setModel(String(flags.model ?? flags.m));
  return h;
}

/** ------------------------------------------------------------------ *
 * headless runners
 * ------------------------------------------------------------------ */

async function runHeadless(h: Harness, input: string, json: boolean): Promise<number> {
  let exitCode = 0;
  let lastText = "";
  for await (const ev of h.chat(input)) {
    if (json) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      continue;
    }
    switch (ev.type) {
      case "delta":
        process.stdout.write(ev.text);
        break;
      case "message":
        if (ev.message.role === "assistant" && ev.message.content) lastText = ev.message.content;
        process.stdout.write("\n");
        break;
      case "tool":
        if (ev.phase === "start") process.stderr.write(`\x1b[2m▸ ${ev.name} ${summarizeArgs(ev.args)}\x1b[0m\n`);
        break;
      case "compaction":
        process.stderr.write(`\x1b[2m· compaction ${ev.phase}${ev.detail ? ": " + ev.detail : ""}\x1b[0m\n`);
        break;
      case "note":
        process.stderr.write(`\x1b[2m· ${ev.text}\x1b[0m\n`);
        if (ev.text.includes("not available") || ev.text.includes("No AI provider")) exitCode = 2;
        break;
      case "done":
        if (ev.reason === "step-limit") exitCode = 3;
        break;
    }
  }
  if (!json && !lastText && exitCode === 0) exitCode = 1;
  process.stdout.write("\n");
  return exitCode;
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

async function chatRepl(h: Harness): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[1m◆\x1b[0m " });
  console.log(`NOIR ${NOIR_VERSION} — chat REPL. /help for commands, !<cmd> for shell, ctrl+c twice to exit.`);
  h.events.sub("log", ({ message }) => process.stderr.write(`\x1b[2m· ${message}\x1b[0m\n`));
  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    try {
      if (input === "/exit" || input === "exit") {
        rl.close();
        process.exit(0);
      }
      if (input.startsWith("/")) {
        const [name, ...args] = input.slice(1).split(/\s+/);
        const cmd = h.commands.get(name);
        process.stdout.write((cmd ? await cmd.run(args, h) : `unknown command /${name} — /help`) + "\n");
      } else if (input.startsWith("!")) {
        const r = await h.runShell(input.slice(1), () => {});
        process.stdout.write(r.output + `\n[exit ${r.exitCode}]\n`);
      } else {
        for await (const ev of h.chat(input)) {
          if (ev.type === "delta") process.stdout.write(ev.text);
          else if (ev.type === "tool" && ev.phase === "start") process.stderr.write(`\n\x1b[2m▸ ${ev.name}\x1b[0m\n`);
          else if (ev.type === "compaction") process.stderr.write(`\n\x1b[2m· compaction ${ev.phase}\x1b[0m\n`);
        }
        process.stdout.write("\n");
      }
    } catch (err) {
      process.stdout.write(`error: ${(err as Error).message}\n`);
    }
    rl.prompt();
  });
  process.on("SIGINT", () => {
    h.abort();
    rl.close();
    process.exit(0);
  });
}

/** ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  if (flags.version || flags.v || flags.help || flags.h) {
    const wantHelp = Boolean(flags.help || flags.h);
    process.stdout.write(wantHelp ? USAGE : `noir ${NOIR_VERSION} (pkg ${pkg.version}, node ${process.version})\n`);
    return 0;
  }

  switch (command) {
    case "tui": {
      const h = await buildHarness(flags);
      const { renderTui } = await import("./tui/app.js");
      await renderTui(h);
      return 0;
    }
    case "serve": {
      const h = await buildHarness(flags);
      const { startServer } = await import("./server/server.js");
      const host = (flags.host as string) || h.config.server.host || "127.0.0.1";
      const port = Number((flags.port as string) || h.config.server.port || 5178);
      const server = await startServer(h, { host, port });
      console.log(`\x1b[1mNOIR app\x1b[0m serving at ${server.url} (token ${server.token ? server.token : "off"})`);
      console.log("Open it in your Android browser → menu → \"Add to Home screen\" to install as an app.");
      if (flags.open) {
        const { spawn } = await import("node:child_process");
        const opener = process.platform === "win32" ? `start ${server.url}` : process.env.TERMUX_VERSION ? `termux-open-url ${server.url}` : `xdg-open ${server.url}`;
        spawn(opener, { shell: true, detached: true, stdio: "ignore" }).unref();
      }
      await new Promise(() => {}); // serve forever
      return 0;
    }
    case "run": {
      const input = positionals.join(" ") || String(flags.task || "");
      if (!input) {
        process.stdout.write('usage: noir run "<task>"\n');
        return 1;
      }
      const h = await buildHarness(flags);
      const code = await runHeadless(h, input, Boolean(flags.json));
      await h.shutdown();
      return code;
    }
    case "chat":
    case "repl": {
      const h = await buildHarness(flags);
      await chatRepl(h);
      return 0;
    }
    case "swarm": {
      const objective = positionals.join(" ");
      if (!objective) {
        process.stdout.write('usage: noir swarm "<objective>"\n');
        return 1;
      }
      const h = await buildHarness(flags);
      h.events.sub("swarm", ({ phase, detail }) => process.stderr.write(`\x1b[2m· swarm ${phase}${detail ? ": " + detail : ""}\x1b[0m\n`));
      const report = await h.swarm.run(objective, { workers: Number(flags.workers ?? 4) });
      process.stdout.write(report + "\n");
      return 0;
    }
    case "agent": {
      const [type, ...rest] = positionals;
      if (!type || rest.length === 0) {
        process.stdout.write('usage: noir agent <type> "<task>"\n');
        return 1;
      }
      const h = await buildHarness(flags);
      const r = await h.subagents.run(type, rest.join(" "), { timeoutMs: 600000 });
      process.stdout.write((r.error ? `subagent failed: ${r.error}` : r.result) + "\n");
      return r.error ? 1 : 0;
    }
    case "sessions": {
      const h = await buildHarness(flags);
      const list = h.listSessions();
      process.stdout.write(list.length ? list.map((s) => `${s.id}  ${String(s.tokens).padStart(7)} tok  ${s.title}`).join("\n") + "\n" : "no sessions\n");
      return 0;
    }
    case "skills":
    case "plugins":
    case "extensions": {
      const h = await buildHarness(flags);
      const name = command === "skills" ? "skills" : command === "plugins" ? "plugins" : "extensions";
      const cmd = h.commands.get(name);
      process.stdout.write((cmd ? await cmd.run([], h) : "missing") + "\n");
      return 0;
    }
    case "mcp":
    case "tools": {
      const h = await buildHarness(flags);
      if (command === "tools") {
        process.stdout.write(h.tools.list().map((t) => `${t.name}: ${t.description.split("\n")[0]}`).join("\n") + "\n");
      } else {
        const cmd = h.commands.get("mcp");
        process.stdout.write((cmd ? await cmd.run([], h) : "missing") + "\n");
      }
      return 0;
    }
    case "memory": {
      const h = await buildHarness(flags);
      const cmd = h.commands.get("memory");
      process.stdout.write((cmd ? await cmd.run(positionals, h) : "missing") + "\n");
      return 0;
    }
    case "models": {
      process.stdout.write(
        Object.entries(PROVIDER_PRESETS)
          .map(([id, p]) => `\x1b[1m${id}\x1b[0m (${p.label})${p.baseUrl ? ` — ${p.baseUrl}` : ""}\n${p.models.map((m) => `   ${m}`).join("\n")}`)
          .join("\n\n") + "\n"
      );
      return 0;
    }
    case "doctor": {
      const h = await buildHarness(flags);
      const cmd = h.commands.get("doctor");
      process.stdout.write((cmd ? await cmd.run([], h) : "missing") + "\n");
      return h.provider ? 0 : 2;
    }
    case "init": {
      const { writeSampleConfig } = await import("./core/config.js");
      const path = writeSampleConfig(process.cwd(), "project");
      process.stdout.write(`sample config written to ${path}\nEdit it, add API keys, then run: noir\n`);
      return 0;
    }
    case "version": {
      process.stdout.write(`noir ${NOIR_VERSION} (pkg ${pkg.version})\n`);
      return 0;
    }
    case "help": {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    default: {
      // `noir "<task>"` shorthand
      if (command && !command.startsWith("-")) {
        const h = await buildHarness(flags);
        const code = await runHeadless(h, [command, ...positionals].join(" "), Boolean(flags.json));
        await h.shutdown();
        return code;
      }
      process.stdout.write(USAGE + "\n");
      return 1;
    }
  }
}

// run when invoked as an entry: via bin/noir.js (argv[1]=...noir.js) or directly (dist/cli.js)
const invokedAs = process.argv[1] ?? "";
if (/(cli|noir)\.js$/i.test(invokedAs)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    }
  );
}
