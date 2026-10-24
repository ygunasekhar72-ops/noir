import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Sessions persist, list, resume; memory store context block. */
export async function test() {
  const dir = tmpProject();
  const h = await makeHarness(dir, {
    script: [{ text: "answer one" }, { text: "answer two" }],
  });

  for await (const _ of h.chat("first question")) void _;
  const s1 = h.session.id;
  assertEq(h.session.title, "first question", "auto title from first user message");
  assert(h.session.messages.some((m) => m.role === "user" && m.content === "first question"), "user message persisted");
  assert(existsSync(join(dir, ".noir", "sessions", `${s1}.json`)), "session file on disk");

  h.newSession("second");
  for await (const _ of h.chat("second question")) void _;
  const list = h.listSessions();
  assertEq(list.length, 2, "two sessions listed");

  const resumed = h.resumeSession(s1);
  assert(resumed && resumed.messages.length === 2, "resume restores messages (user+assistant)");
  assert(resumed.messages[0].content === "first question", "resumed first message correct");

  // memory store
  h.memory.appendNote("user prefers terse answers", "notes");
  h.memory.appendNote("repo uses pnpm", "facts");
  const block = h.memory.contextBlock();
  assert(block.includes("Project notes") && block.includes("terse answers"), `context block notes: ${block.slice(0, 80)}`);
  assert(block.includes("Project facts") && block.includes("pnpm"), "context block facts");
  assertEq(h.memory.readNotes().trim().split("\n").length, 1, "notes append once");

  // snapshot + subagent transcript saving
  h.memory.snapshotBeforeCompaction("sess-x", [{ role: "user", content: "hello" }]);
  h.memory.saveSubagentTranscript("explore", "find stuff", [{ role: "user", content: "find stuff" }]);
  const snaps = h.memory.listSnapshots();
  assert(snaps.length >= 2, "snapshots listed");
  assert(snaps.some((s) => s.file.startsWith("snapshots/")), "pre-compaction snapshot listed");
  assert(snaps.some((s) => s.file.startsWith("snapshots/subagents/")), "subagent transcript listed");

  // notes editing via distillToNotes
  h.memory.distillToNotes("new distilled fact");
  const notes = readFileSync(join(dir, ".noir", "memory", "notes.md"), "utf8");
  assert(notes.includes("new distilled fact") && notes.includes("terse answers"), "distill merges, keeps old");

  await h.shutdown();
}
