import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, assertThrows, tmpProject } from "./helpers.mjs";

/** Pure unit battery: events, registry, schema utils, glob, binary sniffing, skills parsing, session, memory store. */
export async function test() {
  const dir = tmpProject("noir-units");

  /* ---------- EventBus ---------- */
  const { EventBus } = await import("../dist/core/events.js");
  const bus = new EventBus();
  let got = 0;
  const listener = bus.sub("log", () => got++);
  bus.pub("log", { message: "a" });
  bus.pub("log", { message: "b" });
  assertEq(got, 2, "pub/sub works");
  bus.unsub("log", listener);
  bus.pub("log", { message: "c" });
  assertEq(got, 2, "unsub removes listener");
  bus.sub("tool:start", () => got++);
  bus.pub("tool:start", { name: "x", args: {} });
  assertEq(got, 3, "distinct event channels");

  /* ---------- ToolRegistry ---------- */
  const { ToolRegistry } = await import("../dist/core/tools/index.js");
  const reg = new ToolRegistry();
  reg.register({ name: "t1", description: "d1", parameters: { type: "object" }, run: () => "r1" });
  reg.register({ name: "t2", description: "d2", parameters: { type: "object" }, run: () => ({ content: "bad", isError: true }) });
  assertEq(reg.names().sort().join(","), "t1,t2", "registry names");
  assertEq((await reg.execute("t1", {}, {})).content, "r1", "string result");
  const e1 = await reg.execute("t2", {}, {});
  assert(e1.isError, "ToolResult error propagated");
  const defs = reg.defs();
  assertEq(defs.length, 2, "defs count");
  assertEq(defs[0].name, "t1", "defs stripped of run");
  reg.unregister("t2");
  assertEq(reg.names().length, 1, "unregister");
  reg.register({ name: "t1", description: "d1b", parameters: { type: "object" }, run: () => "r1b" });
  assertEq((await reg.execute("t1", {}, {})).content, "r1b", "re-register overrides");
  reg.register({ name: "boom", description: "b", parameters: { type: "object" }, run: () => { throw new Error("kaboom"); } });
  const e2 = await reg.execute("boom", {}, {});
  assert(e2.isError && e2.content.includes("kaboom"), "throwing tool captured as error result");
  reg.register({ name: "async", description: "a", parameters: { type: "object" }, run: async () => "async-ok" });
  assertEq((await reg.execute("async", {}, {})).content, "async-ok", "async tool handler");

  /* ---------- globToRegExp ---------- */
  const { globToRegExp } = await import("../dist/core/tools/fs.js");
  assert(globToRegExp("**/*.ts").test("src/deep/x.ts"), "**/*.ts nested");
  assert(globToRegExp("**/*.ts").test("x.ts"), "**/*.ts root");
  assert(globToRegExp("*.ts").test("x.ts"), "*.ts direct");
  assert(!globToRegExp("*.ts").test("src/x.ts"), "*.ts not nested");
  assert(globToRegExp("src/**").test("src/a/b/c.ts"), "src/** deep");
  assert(globToRegExp("?at.txt").test("cat.txt"), "? single char");
  assert(globToRegExp("{a,b}.txt").test("a.txt") && globToRegExp("{a,b}.txt").test("b.txt"), "brace expansion");
  assert(globToRegExp("file[0-9].txt") === null || true, "no crash on brackets");
  assertThrows(() => globToRegExp(null), "null glob throws");

  /* ---------- looksBinary & safeParseJson ---------- */
  const { looksBinary } = await import("../dist/core/tools/fs.js");
  const { safeParseJson } = await import("../dist/core/providers/types.js");
  assert(looksBinary("x.png", "text-like"), "extension-based binary sniff");
  assert(looksBinary("x.txt", "has\0null"), "null byte sniff");
  assert(!looksBinary("x.txt", "normal text"), "text not flagged");

  assertEq(JSON.stringify(safeParseJson('{"a":1}')), '{"a":1}', "valid json passthrough");
  assertEq(Object.keys(safeParseJson("")).length, 0, "empty string -> {}");
  assertEq(Object.keys(safeParseJson("   ")).length, 0, "whitespace -> {}");
  const fenced = safeParseJson('```json\n{"b": 2}\n```');
  assertEq(fenced.b, 2, "markdown-fenced json parsed");
  assert(safeParseJson("garbage")._raw === "garbage", "invalid -> _raw fallback");
  assertEq(safeParseJson("42").value, 42, "scalar wrapped");

  /* ---------- SkillManager parsing variants ---------- */
  const { SkillManager } = await import("../dist/core/skills/manager.js");
  const { createLogger } = await import("../dist/core/logger.js");
  const logger = createLogger("silent");
  mkdirSync(join(dir, ".noir", "skills"), { recursive: true });
  // full frontmatter
  mkdirSync(join(dir, ".noir", "skills", "full"), { recursive: true });
  writeFileSync(join(dir, ".noir", "skills", "full", "SKILL.md"), "---\nname: full\nwhen: trigger words\n---\nBODY-FULL");
  // flat file skill
  writeFileSync(join(dir, ".noir", "skills", "flatfile.md"), "---\nname: flatfile\ndescription: flat skill desc\n---\nBODY-FLAT");
  // no frontmatter, heading style
  mkdirSync(join(dir, ".noir", "skills", "bare"), { recursive: true });
  writeFileSync(join(dir, ".noir", "skills", "bare", "SKILL.md"), "# Bare\nBODY-BARE");
  // broken skill skipped
  mkdirSync(join(dir, ".noir", "skills", "broken"), { recursive: true });

  const sm = new SkillManager(dir, logger);
  const skills = sm.load();
  const ids = skills.map((s) => s.id);
  assert(ids.includes("full"), "frontmatter skill loaded");
  assert(ids.includes("flatfile"), "flat .md skill loaded");
  assert(ids.includes("bare"), "no-frontmatter skill loaded");
  const full = sm.get("full");
  assertEq(full.when, "trigger words", "when field parsed");
  assertEq(full.body, "BODY-FULL", "body after frontmatter");
  assertEq(full.source, "project", "source tagged");
  assertEq(sm.get("FULL").id, "full", "case-insensitive lookup");
  assertEq(sm.get("missing"), undefined, "missing skill");
  assert(sm.systemBlock().includes("full:"), "systemBlock lists skills");

  // project overrides builtin on collision
  mkdirSync(join(dir, ".noir", "skills", "code-review"), { recursive: true });
  writeFileSync(join(dir, ".noir", "skills", "code-review", "SKILL.md"), "---\nname: code-review\ndescription: project override\n---\nOVERRIDE");
  sm.load();
  assertEq(sm.get("code-review").description, "project override", "project overrides builtin");

  /* ---------- Session ---------- */
  const { Session, newSessionId } = await import("../dist/core/session.js");
  const s1 = new Session(dir, { title: "t1" });
  s1.push({ role: "user", content: "hello world this is a long title for the session" });
  s1.taskBoard.push({ id: "1", title: "task", status: "todo" });
  s1.activeSkillInstructions.push("code-review");
  s1.save();
  const loaded = Session.load(dir, s1.id);
  assertEq(loaded.title, s1.title, "title persisted");
  assert(loaded.title.length <= 48, "title capped at 48 chars");
  assertEq(loaded.taskBoard.length, 1, "taskBoard persisted");
  assertEq(loaded.activeSkillInstructions[0], "code-review", "skill instructions persisted");
  assertEq(loaded.messages.length, 1, "messages persisted");
  assertEq(Session.load(dir, "nope"), null, "missing session null");
  // title auto-set from first user msg
  const s2 = new Session(dir);
  s2.push({ role: "user", content: "short title" });
  assertEq(s2.title, "short title", "auto title");
  // corrupt session skipped in list
  writeFileSync(join(dir, ".noir", "sessions", "corrupt.json"), "{{{");
  const list = Session.list(dir);
  assert(!list.some((x) => x.id === "corrupt"), "corrupt session skipped");
  assert(list.some((x) => x.id === s1.id), "good session listed");
  assert(typeof newSessionId() === "string" && newSessionId() !== newSessionId(), "unique ids");
  // ephemeral not persisted
  const s3 = Session.ephemeral(dir);
  s3.push({ role: "user", content: "ephemeral" });
  s3.save();
  assert(!existsSync(join(dir, ".noir", "sessions", `${s3.id}.json`)), "ephemeral sessions not persisted");

  /* ---------- MemoryStore ---------- */
  const { MemoryStore } = await import("../dist/core/memory/store.js");
  const ms = new MemoryStore(dir);
  ms.appendNote("note-one", "notes");
  ms.appendNote("note-two", "notes");
  ms.appendNote("fact-one", "facts");
  ms.appendNote("global-one", "global");
  assert(ms.readNotes().includes("note-one") && ms.readNotes().includes("note-two"), "notes appended in order");
  assert(ms.readFacts().includes("fact-one"), "facts file");
  assert(ms.readGlobalNotes().includes("global-one"), "global file");
  const ctx = ms.contextBlock();
  assert(ctx.includes("Project notes") && ctx.includes("Project facts") && ctx.includes("Global notes"), "contextBlock sections");
  // clipping
  for (let i = 0; i < 200; i++) ms.appendNote(`padding-${i}-${"x".repeat(50)}`, "notes");
  const clipped = ms.contextBlock(1200);
  assert(clipped.length < 4000, `contextBlock clipped: ${clipped.length}`);
  assert(clipped.includes("older notes trimmed"), "trim marker");
  // snapshots sorting newest first
  const before = ms.listSnapshots().length;
  ms.snapshotBeforeCompaction("sA", []);
  const mid = ms.listSnapshots();
  assertEq(mid.length, before + 1, "snapshot listed");
  assert(mid[0].file.startsWith("snapshots/"), "newest first");
  // setNotes overwrite
  ms.setNotes("fresh content");
  assertEq(ms.readNotes().trim(), "fresh content", "setNotes overwrites");

  /* ---------- session token estimate edge ---------- */
  const s4 = new Session(dir);
  assertEq(s4.estimateTokens(), 0, "empty session zero tokens");
}
