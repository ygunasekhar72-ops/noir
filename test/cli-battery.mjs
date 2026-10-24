import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq, tmpProject } from "./helpers.mjs";

/** Full CLI surface: every subcommand, flags, JSON mode, project isolation. */
export async function test() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const home = tmpProject("noir-cli-home");
  const proj = tmpProject("noir-cli-proj");
  const ENV = { ...process.env, NOIR_HOME: home, NOIR_PROVIDER: "mock", NOIR_MODEL: "mock" };

  function run(args, cwd = proj) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [join(root, "bin", "noir.js"), ...args], { cwd, env: ENV });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  }

  /* ---- help / version / models ---- */
  let r = await run(["help"]);
  assertEq(r.code, 0, "help exit 0");
  assert(r.out.includes("usage: noir") && r.out.includes("swarm"), "help content");
  r = await run(["--help"]);
  assert(r.out.includes("usage: noir"), "--help alias");
  r = await run(["-h"]);
  assert(r.out.includes("usage: noir"), "-h alias");
  r = await run(["version"]);
  assert(r.out.includes("noir 0.1.0"), "version command");
  r = await run(["--version"]);
  assert(r.out.includes("noir 0.1.0"), "--version alias");
  r = await run(["models"]);
  assert(r.out.includes("openai") && r.out.includes("gemini-2.5-flash") && r.out.includes("ollama"), "models lists providers");

  /* ---- doctor (mock provider) ---- */
  r = await run(["doctor"]);
  assertEq(r.code, 0, "doctor exit 0 with mock");
  assert(r.out.includes("provider: mock / model: mock — ready"), "doctor provider line");
  assert(r.out.includes("shell: ok"), "doctor shell check");
  assert(r.out.includes("memory workspace:"), "doctor memory line");

  /* ---- registries (BEFORE init — the sample config adds an example MCP server) ---- */
  r = await run(["tools"]);
  assert(r.out.includes("read_file") && r.out.includes("spawn_subagent") && r.out.includes("swarm"), "tools lists all builtins");
  r = await run(["skills"]);
  assert(r.out.includes("code-review"), "skills lists builtins");
  r = await run(["plugins"]);
  assertEq(r.code, 0, "plugins exit 0 (empty ok)");
  r = await run(["extensions"]);
  assertEq(r.code, 0, "extensions exit 0 (empty ok)");
  r = await run(["mcp"]);
  assert(r.out.toLowerCase().includes("no mcp servers connected"), "mcp empty state");
  r = await run(["memory"]);
  assert(r.out.includes("notes.md"), "memory output");

  /* ---- init (after registry checks — its sample config adds an example MCP server) ---- */
  r = await run(["init"]);
  assertEq(r.code, 0, "init exit 0");
  assert(existsSync(join(proj, ".noir", "config.json")), "init wrote project config");
  assert(r.out.includes("sample config written"), "init message");
  r = await run(["memory", "add", "cli note"], proj);
  assert(r.out.includes("note added"), "memory add via CLI");
  r = await run(["memory"]);
  assert(r.out.includes("cli note"), "memory add persisted");

  /* ---- run: JSON event stream ---- */
  r = await run(["run", "--json", "hello json mode"]);
  assertEq(r.code, 0, "json run exit 0");
  const lines = r.out.trim().split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  assert(events.some((e) => e.type === "delta" && e.text.includes("mock: no script left")), "json stream has delta event");
  assert(events.some((e) => e.type === "done"), "json stream has done event");
  assert(events.every((e) => typeof e.type === "string"), "all lines valid JSON events");

  /* ---- run: plain mode ---- */
  r = await run(["run", "plain task"]);
  assert(r.out.includes("mock: no script left"), "plain run prints reply");
  assert(r.err.includes("done") || r.out.includes("mock"), "run output");

  /* ---- sessions list (empty) ---- */
  r = await run(["sessions"]);
  assertEq(r.code, 0, "sessions exit 0");
  assert(r.out.includes("no sessions") || r.out.includes("s-"), "sessions output");

  /* ---- shorthand task: `noir "<task>"` ---- */
  r = await run(["shorthand task works"]);
  assert(r.out.includes("mock: no script left"), "shorthand run");
  assertEq(r.code, 0, "shorthand exit 0");

  /* ---- unknown command = treated as task (documented behavior) ---- */
  r = await run(["totally-unknown-command"]);
  assertEq(r.code, 0, "unknown first arg treated as one-shot task");

  /* ---- agent subcommand (mock) ---- */
  r = await run(["agent", "explore", "find things"]);
  assertEq(r.code, 0, "agent command exit 0");
  assert(r.out.includes("mock: no script left"), "agent ran with mock provider");

  /* ---- project isolation: -C flag ---- */
  r = await run(["memory"], proj);
  assert(r.out.includes("cli note"), "default cwd project");
  const proj2 = tmpProject("noir-cli-proj2");
  r = await run(["-C", proj2, "memory"]);
  assert(!r.out.includes("cli note"), "-C flag switches project (isolated memory)");

  /* ---- quiet flag ---- */
  r = await run(["-q", "doctor"]);
  assert(!r.err.includes("[noir:"), "quiet suppresses logs");

  /* ---- no-args = TUI (non-tty guard) ---- */
  r = await run([]);
  // In non-TTY the TUI may fail or exit quickly; we only care it doesn't hang or spew stack traces
  assert(!r.out.includes("at Module.test") && !r.err.includes("SyntaxError"), "TUI entry fails gracefully without TTY");
}
