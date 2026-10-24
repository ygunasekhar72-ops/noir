import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Agent loop edge cases: limits, aborts, provider crashes, guards, output caps. */
export async function test() {
  /* ---- 1. maxSteps limit ---- */
  const dir1 = tmpProject("noir-ag1");
  const endless = await makeHarness(dir1, {
    config: { maxSteps: 3 },
    script: Array.from({ length: 10 }, (_, i) => ({ toolCalls: [{ id: `t${i}`, name: "task_board", arguments: { action: "add", title: `t${i}` } }] })),
  });
  const ev1 = [];
  for await (const ev of endless.chat("loop forever")) ev1.push(ev);
  const done1 = ev1.find((e) => e.type === "done");
  assertEq(done1.reason, "step-limit", "step limit reached");
  assert(ev1.some((e) => e.type === "note" && e.text.includes("step limit")), "step-limit note emitted");
  assertEq(endless.session.taskBoard.length, 3, "exactly maxSteps tool calls executed");
  await endless.shutdown();

  /* ---- 2. abort mid-generation ---- */
  const dir2 = tmpProject("noir-ag2");
  const { Harness } = await import("../dist/core/harness.js");
  const slow = {
    id: "slow",
    label: "Slow",
    async *stream(opts) {
      for (let i = 0; i < 20; i++) {
        if (opts.signal?.aborted) throw new Error("aborted");
        await new Promise((res) => setTimeout(res, 30));
        yield { type: "text", text: `chunk${i} ` };
      }
    },
  };
  const h2 = await Harness.create({ projectDir: dir2, provider: slow, model: "slow", loadModules: false, connectMcp: false, configOverrides: { logging: { level: "silent" } } });
  await h2.modulesReady;
  const ev2 = [];
  const consumer = (async () => {
    for await (const ev of h2.chat("write a novel")) ev2.push(ev);
  })();
  await new Promise((res) => setTimeout(res, 120));
  h2.abort();
  await consumer;
  const done2 = ev2.find((e) => e.type === "done");
  assertEq(done2.reason, "aborted", "abort -> done aborted");
  assert(ev2.some((e) => e.type === "note" && e.text.includes("aborted")), "abort note emitted");
  assert(ev2.filter((e) => e.type === "delta").length < 20, "fewer chunks than full run");
  await h2.shutdown();

  /* ---- 3. busy guard: second chat while first is STILL running ---- */
  const evBusy = [];
  const slowConsumer = (async () => {
    for await (const ev of h2.chat("long running turn")) evBusy.push(ev);
  })();
  await new Promise((res) => setTimeout(res, 120)); // first turn mid-flight
  const ev3 = [];
  for await (const ev of h2.chat("second while busy")) ev3.push(ev);
  assert(ev3.some((e) => e.type === "note" && e.text.includes("already running")), "busy guard note");
  assertEq(ev3.find((e) => e.type === "done").reason, "end", "busy guard ends cleanly");
  h2.abort();
  await slowConsumer;
  assert(evBusy.some((e) => e.type === "done" && e.reason === "aborted"), "first turn aborted after busy probe");

  /* ---- 4. empty input guard ---- */
  const ev4 = [];
  for await (const ev of h2.chat("   ")) ev4.push(ev);
  assert(ev4.some((e) => e.type === "note" && e.text.includes("empty input")), "empty input guarded");
  await h2.shutdown();

  /* ---- 5. provider crash propagates cleanly ---- */
  const dir5 = tmpProject("noir-ag5");
  const bomb = {
    id: "bomb",
    label: "Bomb",
    async *stream() {
      yield { type: "text", text: "partial " };
      throw new Error("provider exploded");
    },
  };
  const h5 = await Harness.create({ projectDir: dir5, provider: bomb, model: "bomb", loadModules: false, connectMcp: false, configOverrides: { logging: { level: "silent" } } });
  await h5.modulesReady;
  let threw = null;
  try {
    for await (const _ of h5.chat("trigger")) void _;
  } catch (err) {
    threw = err;
  }
  assert(threw && threw.message.includes("provider exploded"), "provider error propagates to caller");
  assert(h5.session.messages.length >= 1, "user message persisted despite crash");
  await h5.shutdown();

  /* ---- 6. toolOutputLimit caps tool results ---- */
  const dir6 = tmpProject("noir-ag6");
  const big = "B".repeat(20000);
  const h6 = await makeHarness(dir6, {
    config: { toolOutputLimit: 1000 },
    script: [
      { toolCalls: [{ id: "t1", name: "write_file", arguments: { path: "big-out.txt", content: big } }] },
      { toolCalls: [{ id: "t2", name: "read_file", arguments: { path: "big-out.txt" } }] },
      { text: "done" },
    ],
  });
  const ev6 = [];
  for await (const ev of h6.chat("make and read a big file")) ev6.push(ev);
  const toolMsg = h6.session.messages.find((m) => m.role === "tool" && m.name === "read_file");
  assert(toolMsg.content.length < 20000, `tool result capped: ${toolMsg.content.length}`);
  assert(toolMsg.content.includes("truncated at 1000"), "truncation marker present");
  await h6.shutdown();

  /* ---- 7. multiple tool calls in one turn execute in order ---- */
  const dir7 = tmpProject("noir-ag7");
  const h7 = await makeHarness(dir7, {
    script: [
      {
        toolCalls: [
          { id: "a", name: "write_file", arguments: { path: "seq.txt", content: "one" } },
          { id: "b", name: "edit_file", arguments: { path: "seq.txt", oldString: "one", newString: "two" } },
        ],
      },
      { text: "sequence complete" },
    ],
  });
  const ev7 = [];
  for await (const ev of h7.chat("chain two tools")) ev7.push(ev);
  const starts = ev7.filter((e) => e.type === "tool" && e.phase === "start").map((e) => e.name);
  assertEq(starts.join(","), "write_file,edit_file", "sequential execution order");
  assert(readFileSync(join(dir7, "seq.txt"), "utf8") === "two", "second tool saw first tool's effect");
  await h7.shutdown();

  /* ---- 8. restricted agent calling forbidden tool ---- */
  const dir8 = tmpProject("noir-ag8");
  const h8 = await makeHarness(dir8, {
    script: [
      { toolCalls: [{ id: "x", name: "run_command", arguments: { command: "echo should-not-run" } }] },
      { text: "after restriction" },
    ],
  });
  // build an Agent manually with explore's restricted toolset
  const { Agent } = await import("../dist/core/agent/agent.js");
  const { Session } = await import("../dist/core/session.js");
  const s8 = Session.ephemeral(dir8);
  const agent8 = new Agent({
    provider: h8.provider,
    model: h8.model,
    session: s8,
    registry: h8.tools,
    config: h8.config,
    memory: h8.memory,
    skills: h8.skills,
    events: h8.events,
    logger: h8.logger,
    makeCtx: (sess) => h8.makeCtx(sess),
    allowedTools: h8.subagents.getDef("explore").tools,
    systemExtra: "subagent test",
  });
  const ev8 = [];
  for await (const ev of agent8.run("run a shell command please")) ev8.push(ev);
  const denied = h8.tools.list() && ev8.find((e) => e.type === "tool" && e.phase === "end" && e.ok === false);
  assert(denied && denied.result.includes("not available"), "forbidden tool denied with clear message");
  await h8.shutdown();

  /* ---- 9. system prompt composition ---- */
  const dir9 = tmpProject("noir-ag9");
  const h9 = await makeHarness(dir9, { script: [{ text: "ok" }] });
  await h9.memory.appendNote("sys-prompt-note-evidence", "notes");
  await h9.memory.appendNote("fact-evidence", "facts");
  const { Agent: Agent9 } = await import("../dist/core/agent/agent.js");
  const { Session: Session9 } = await import("../dist/core/session.js");
  const agent9 = new Agent9({
    provider: h9.provider,
    model: h9.model,
    session: h9.session,
    registry: h9.tools,
    config: h9.config,
    memory: h9.memory,
    skills: h9.skills,
    events: h9.events,
    logger: h9.logger,
    makeCtx: (sess) => h9.makeCtx(sess),
  });
  const sys = agent9.buildSystemPrompt();
  assert(sys.includes("You are NOIR"), "identity present");
  assert(sys.includes("sys-prompt-note-evidence"), "memory notes injected");
  assert(sys.includes("fact-evidence"), "facts injected");
  assert(sys.includes("code-review"), "skills listed");
  assert(sys.includes("Tool policy"), "tool policy present");
  assert(sys.includes(dir9) || sys.includes(dir9.replace(/\\/g, "\\\\")), "project dir present");
  // task board renders
  h9.session.taskBoard.push({ id: "1", title: "board item", status: "todo" });
  const sys2 = agent9.buildSystemPrompt();
  assert(sys2.includes("board item"), "task board in prompt");

  /* ---- 10. consecutive turns & token estimate sanity ---- */
  for await (const _ of h9.chat("turn one")) void _;
  for await (const _ of h9.chat("turn two")) void _;
  assertEq(h9.session.messages.length, 4, "two full turns persisted");
  assert(h9.session.estimateTokens() > 0, "token estimate positive");
  assertEq(h9.listSessions().length, 1, "one session file");
  const persisted = JSON.parse(readFileSync(join(dir9, ".noir", "sessions", `${h9.session.id}.json`), "utf8"));
  assertEq(persisted.messages.length, 4, "session file matches memory");
  assert(persisted.taskBoard.length === 1, "task board persisted in session file");

  await h9.shutdown();
}
