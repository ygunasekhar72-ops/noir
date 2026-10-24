import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Compactor edge cases: parsing variants, provider failure fallback, integrity. */
export async function test() {
  const dir = tmpProject("noir-comp");

  /* ---- 1. summary without NOTES section -> no notes written ---- */
  const h1 = await makeHarness(dir, {
    config: { compactAtTokens: 50 },
    script: [
      { text: "X".repeat(500) },
      { text: "SUMMARY:\nJust a summary, no notes section here at all." },
      { text: "post" },
    ],
  });
  for await (const _ of h1.chat("go")) void _;
  const notesPath = join(dir, ".noir", "memory", "notes.md");
  const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
  assert(!notes.includes("Just a summary"), "summary body not dumped into notes");
  assert(existsSync(join(dir, ".noir", "memory", "snapshots", "summaries")), "summary saved");
  await h1.shutdown();

  /* ---- 2. NOTES: NONE -> no notes ---- */
  const dir2 = tmpProject("noir-comp2");
  const h2 = await makeHarness(dir2, {
    config: { compactAtTokens: 50 },
    script: [{ text: "Y".repeat(500) }, { text: "SUMMARY:\ns2\n\nNOTES:\nNONE" }, { text: "post" }],
  });
  for await (const _ of h2.chat("go")) void _;
  const notesPath2 = join(dir2, ".noir", "memory", "notes.md");
  const notes2 = existsSync(notesPath2) ? readFileSync(notesPath2, "utf8") : "";
  assert(!notes2.includes("NONE"), "NONE keyword not written as a note");
  await h2.shutdown();

  /* ---- 3. compactor NEVER crashes the turn when the provider fails ---- */
  const dir3 = tmpProject("noir-comp3");
  const { Harness } = await import("../dist/core/harness.js");
  let failNext = false;
  const flaky = {
    id: "flaky",
    label: "Flaky",
    async *stream(opts) {
      if (failNext) throw new Error("distill blew up");
      const last = [...opts.messages].reverse().find((m) => m.role === "user");
      if (opts.messages.length === 1 && last.content.length > 200) {
        // called by compactor with the big transcript -> fail on demand
        if (failNext) throw new Error("distill blew up");
      }
      yield { type: "text", text: "Z".repeat(600) };
    },
  };
  const h3 = await Harness.create({ projectDir: dir3, provider: flaky, model: "flaky", loadModules: false, connectMcp: false, configOverrides: { compactAtTokens: 50, logging: { level: "silent" } } });
  await h3.modulesReady;
  // swap in a wrapper that fails only on the SECOND stream call (= compaction)
  let calls = 0;
  const original = h3.provider;
  h3.provider = {
    id: "flaky2",
    label: "Flaky2",
    async *stream(opts) {
      calls++;
      if (calls === 2) throw new Error("distill blew up");
      yield* original.stream(opts);
    },
  };
  h3["rebuildAgentRunners"](); // rebinds compactor + subagents + swarm to the new provider
  const ev3 = [];
  for await (const ev of h3.chat("make it compact")) ev3.push(ev);
  assert(ev3.some((e) => e.type === "compaction" && e.phase === "saved"), "snapshot still saved on distill failure");
  assert(ev3.some((e) => e.type === "compaction" && e.phase === "done"), "compaction completed despite provider failure");
  assert(h3.session.messages.length === 1, "session still reset with fallback summary");
  assert(h3.session.messages[0].content.includes("FULL transcript is preserved"), "fallback summary references the snapshot");
  assert(existsSync(join(dir3, ".noir", "memory", "snapshots")), "snapshot dir exists");
  await h3.shutdown();

  /* ---- 4. snapshot integrity: exact messages preserved ---- */
  const dir4 = tmpProject("noir-comp4");
  const h4 = await makeHarness(dir4, {
    config: { compactAtTokens: 50 },
    script: [
      { toolCalls: [{ id: "tc", name: "write_file", arguments: { path: "f.txt", content: "data" } }] },
      { text: "W".repeat(600) },
      { text: "SUMMARY:\nfinal summary text\n\nNOTES:\n- durable fact one\n- durable fact two" },
      { text: "post" },
    ],
  });
  for await (const _ of h4.chat("write then talk")) void _;
  const snapDir = join(dir4, ".noir", "memory", "snapshots");
  const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".json") && !f.includes("subagents"));
  assertEq(snapFiles.length, 1, "one snapshot");
  const snap = JSON.parse(readFileSync(join(snapDir, snapFiles[0]), "utf8"));
  const snapUser = snap.messages.find((m) => m.role === "user");
  assertEq(snapUser.content, "write then talk", "original user message byte-exact");
  const snapTool = snap.messages.find((m) => m.role === "tool");
  assert(snapTool && snapTool.toolCallId === "tc", "tool result preserved in snapshot");
  const notes4 = readFileSync(join(dir4, ".noir", "memory", "notes.md"), "utf8");
  assert(notes4.includes("durable fact one") && notes4.includes("durable fact two"), "both notes merged");
  await h4.shutdown();

  /* ---- 5. estimateTokens sanity ---- */
  const { Session } = await import("../dist/core/session.js");
  const s5 = Session.ephemeral(dir4);
  s5.push({ role: "user", content: "a".repeat(4000) });
  assertEq(s5.estimateTokens(), 1000, "4 chars/token estimate");
  s5.push({ role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: { k: "v".repeat(800) } }] });
  assert(s5.estimateTokens() > 1000, "tool calls counted in estimate");
}
