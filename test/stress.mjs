import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Stress & scale: big sessions, many MCP tools, deep trees, server bursts, swarm scale. */
export async function test() {
  /* ---- 1. 200-message session: save/load integrity + performance ---- */
  const dir = tmpProject("noir-stress");
  const h = await makeHarness(dir, {
    script: Array.from({ length: 100 }, (_, i) => ({ text: `reply number ${i} — ${"content ".repeat(40)}` })),
  });
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    for await (const _ of h.chat(`question number ${i}`)) void _;
  }
  const elapsed = Date.now() - t0;
  assertEq(h.session.messages.length, 200, "200 messages accumulated");
  assert(elapsed < 60000, `100 turns completed in reasonable time (${elapsed}ms)`);
  const t1 = Date.now();
  const resumed = await import("../dist/core/session.js").then((m) => m.Session.load(dir, h.session.id));
  assert(resumed && resumed.messages.length === 200, "large session reloads intact");
  assert(Date.now() - t1 < 5000, "large session loads fast");

  /* ---- 2. token estimate on big session ---- */
  assert(h.session.estimateTokens() > 5000, "large session token estimate substantial");

  /* ---- 3. list_sessions with 25 sessions ---- */
  for (let i = 0; i < 25; i++) {
    const s = await import("../dist/core/session.js").then((m) => new m.Session(dir));
    s.push({ role: "user", content: `session ${i}` });
    s.save();
  }
  const list = h.listSessions();
  assert(list.length >= 26, "all sessions listed");
  const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  assertEq(JSON.stringify(list.map((x) => x.id)), JSON.stringify(sorted.map((x) => x.id)), "sessions sorted newest first");

  /* ---- 4. deep directory tree (100 levels) ---- */
  let deep = dir;
  for (let i = 0; i < 60; i++) deep = join(deep, "n");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "bottom.txt"), "found the bottom\n");
  const ctx = h.makeCtx(h.session);
  const r = await h.tools.execute("list_files", { pattern: "**/bottom.txt" }, ctx);
  assert(r.content.includes("bottom.txt"), "deep tree globbed");
  const r2 = await h.tools.execute("search_files", { pattern: "bottom" }, ctx);
  assert(r2.content.includes("bottom.txt"), "deep tree grepped");

  /* ---- 5. wide directory (600 files) ---- */
  const wide = join(dir, "wide");
  mkdirSync(wide, { recursive: true });
  for (let i = 0; i < 600; i++) writeFileSync(join(wide, `w${i}.txt`), `content ${i}\n`);
  const r3 = await h.tools.execute("list_files", { pattern: "wide/w*.txt" }, ctx);
  assert(r3.content.includes("600 match") || r3.content.includes("match(es)"), "wide glob count");
  const r4 = await h.tools.execute("search_files", { pattern: "content 599" }, ctx);
  assert(r4.content.includes("w599.txt:1:"), "wide grep hit");
  const r5 = await h.tools.execute("search_files", { pattern: "content", include: "**/w*.txt" }, ctx);
  assert(r5.content.includes("capped") || r5.content.includes("200 match"), "match cap applied");

  /* ---- 6. big file read capped, not OOM ---- */
  writeFileSync(join(dir, "huge.txt"), Array.from({ length: 50000 }, () => "L".repeat(80)).join("\n") + "\n");
  const t2 = Date.now();
  const r6 = await h.tools.execute("read_file", { path: "huge.txt" }, ctx);
  assert(!r6.isError, "huge file readable");
  assert(Date.now() - t2 < 10000, "huge file read fast");
  assert(r6.content.includes("more lines"), "huge file paged");
  const r6b = await h.tools.execute("read_file", { path: "huge.txt", offset: 49000, limit: 100 }, ctx);
  assert(r6b.content.includes("49000|"), "deep offset paging works");

  /* ---- 7. many MCP tools registered & deduped ---- */
  const { McpManager } = await import("../dist/core/mcp/manager.js");
  const { EventBus } = await import("../dist/core/events.js");
  const { createLogger } = await import("../dist/core/logger.js");
  const logger = createLogger("silent");
  const fakeMgr = new McpManager(h.config, logger, new EventBus());
  // simulate 60 tools from 3 servers via direct registration
  const many = [];
  for (let s = 0; s < 3; s++) {
    for (let t = 0; t < 20; t++) {
      many.push({ server: `srv${s}`, tool: { name: `tool_${t}`, description: `tool ${t} of server ${s}`, inputSchema: { type: "object" } } });
    }
  }
  fakeMgr.aggregate = () => many;
  fakeMgr.listServers = () => [
    { name: "srv0", transport: "stdio", connected: true, tools: 20 },
    { name: "srv1", transport: "stdio", connected: true, tools: 20 },
    { name: "srv2", transport: "stdio", connected: true, tools: 20 },
  ];
  const before = h.tools.names().length;
  const realMgr = h.mcp;
  h.mcp = fakeMgr;
  h.registerMcpTools();
  assertEq(h.tools.names().length, before + 60, "60 mcp tools registered");
  h.registerMcpTools(); // idempotent
  assertEq(h.tools.names().length, before + 60, "re-registration deduped");
  assert(h.tools.has("mcp__srv1__tool_7"), "prefixed name registered");
  h.mcp = realMgr;

  /* ---- 8. swarm with 8 tasks, 2 workers ---- */
  const dir8 = tmpProject("noir-stress2");
  const { Harness } = await import("../dist/core/harness.js");
  const { MockProvider } = await import("../dist/core/providers/index.js");
  const provider = new MockProvider([], (messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const c = lastUser?.content ?? "";
    if (c.includes("Decompose")) return { text: Array.from({ length: 12 }, (_, i) => `- [research] task ${i}`).join("\n") };
    if (c.includes("Worker reports")) return { text: "STRESS REPORT DONE" };
    return { text: "work ok" };
  });
  const h8 = await Harness.create({ projectDir: dir8, provider, model: "m", loadModules: false, connectMcp: false, configOverrides: { logging: { level: "silent" } } });
  await h8.modulesReady;
  const report = await h8.swarm.run("stress objective", { workers: 2 });
  assert(report.includes("STRESS REPORT DONE"), "swarm completes at scale");
  const { readdirSync } = await import("node:fs");
  const boardFile = readdirSync(join(dir8, ".noir", "swarm"))[0];
  const board = JSON.parse(readFileSync(join(dir8, ".noir", "swarm", boardFile), "utf8"));
  assertEq(board.tasks.length, 8, "planner capped at 8 tasks");
  assert(board.tasks.every((t) => t.status === "done"), "all stress workers done");

  /* ---- 9. planner garbage -> single-task fallback ---- */
  const provider2 = new MockProvider([], (messages) => {
    const c = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (c.includes("Worker reports")) return { text: "FALLBACK REPORT" };
    return { text: "I refuse to produce a task list, here is prose instead." };
  });
  const h9 = await Harness.create({ projectDir: dir8, provider: provider2, model: "m", loadModules: false, connectMcp: false, configOverrides: { logging: { level: "silent" } } });
  await h9.modulesReady;
  const report2 = await h9.swarm.run("fallback objective");
  assert(report2.includes("FALLBACK REPORT"), "garbage plan falls back to single task");
  await h9.shutdown();

  await h.shutdown();
}
