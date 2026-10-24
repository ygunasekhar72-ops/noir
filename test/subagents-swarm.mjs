import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, tmpProject } from "./helpers.mjs";

/** Subagents run isolated sessions; swarm plans -> works -> synthesizes. */
export async function test() {
  const dir = tmpProject();

  const { Harness } = await import("../dist/core/harness.js");
  const { MockProvider } = await import("../dist/core/providers/index.js");

  const provider = new MockProvider([], (messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const c = lastUser?.content ?? "";
    if (c.includes("Decompose")) return { text: "- [research] find X\n- [code] build Y\n- [write] document Z" };
    if (c.includes("Worker reports")) return { text: "FINAL SWARM REPORT: 3 tasks completed." };
    if (c.includes("find X")) return { text: "X found: 3 relevant files, main is src/x.ts" };
    if (c.includes("build Y")) return { text: "Y built and verified with tests passing" };
    if (c.includes("document Z")) return { text: "Z documented in README" };
    return { text: "ok" };
  });

  const h = await Harness.create({
    projectDir: dir,
    provider,
    model: "mock-model",
    loadModules: false,
    connectMcp: false,
    configOverrides: { logging: { level: "silent" } },
  });
  await h.modulesReady;

  // ---- subagent
  const r = await h.subagents.run("explore", "find X");
  assert(!r.error, `subagent error: ${r.error}`);
  assert(r.result.includes("X found"), `subagent result: ${r.result.slice(0, 80)}`);
  const subTranscripts = readdirSync(join(dir, ".noir", "memory", "snapshots", "subagents"));
  assert(subTranscripts.length >= 1, "subagent transcript persisted to memory workspace");
  const t = JSON.parse(readFileSync(join(dir, ".noir", "memory", "snapshots", "subagents", subTranscripts[0]), "utf8"));
  assertEq(t.subagent, "explore", "transcript tagged with subagent type");
  assertEq(t.task, "find X", "transcript tagged with task");

  // role restriction: coder does not get web tools
  const coder = h.subagents.getDef("coder");
  assert(!coder.tools.includes("web_search"), "coder lacks web tools");
  const researcher = h.subagents.getDef("researcher");
  assert(researcher.tools.includes("web_search"), "researcher has web tools");

  // custom agent defs via .noir/agents/*.json
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(dir, ".noir", "agents"), { recursive: true });
  writeFileSync(join(dir, ".noir", "agents", "auditor.json"), JSON.stringify({ description: "audit specialist", tools: ["read_file", "search_files"] }), "utf8");
  h.subagents.loadDefs();
  assert(h.subagents.getDef("auditor"), "custom agent def loaded");

  // ---- swarm
  const events = [];
  const onSwarm = (p) => events.push(p.phase);
  h.events.sub("swarm", onSwarm);
  const report = await h.swarm.run("build the demo feature", { workers: 3 });
  assert(report.includes("FINAL SWARM REPORT"), `swarm report: ${report.slice(0, 80)}`);
  assert(events.includes("plan") && events.includes("work") && events.includes("synthesize") && events.includes("done"), `swarm phases: ${events.join(",")}`);
  h.events.unsub("swarm", onSwarm);

  const swarmDir = join(dir, ".noir", "swarm");
  assert(existsSync(swarmDir), "swarm board dir");
  const boardFile = readdirSync(swarmDir)[0];
  const board = JSON.parse(readFileSync(join(swarmDir, boardFile), "utf8"));
  assertEq(board.tasks.length, 3, "3 planned tasks");
  assert(board.tasks.every((t2) => t2.status === "done"), "all workers done");

  await h.shutdown();
}
