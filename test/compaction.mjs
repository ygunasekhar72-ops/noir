import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** THE memory guarantee: full transcript snapshot BEFORE compaction + distilled notes. */
export async function test() {
  const dir = tmpProject();
  const h = await makeHarness(dir, {
    config: { compactAtTokens: 300 },
    script: [
      { text: "A".repeat(2000) }, // ~500 tokens -> crosses the 300-token threshold after turn 1
      {
        text: "SUMMARY:\nThe user asked to set up the project and a large answer was produced.\n\nNOTES:\n- project uses the NOIR harness\n- keep answers terse",
      },
      { text: "after compaction reply" },
    ],
  });

  const events = [];
  for await (const ev of h.chat("tell me something long")) events.push(ev);

  // compaction ran during/after the turn
  assert(events.some((e) => e.type === "compaction"), "compaction events emitted");

  // 1. full transcript snapshot saved BEFORE compaction
  const snapDir = join(dir, ".noir", "memory", "snapshots");
  assert(existsSync(snapDir), "snapshots dir exists");
  const snaps = readdirSync(snapDir).filter((f) => f.endsWith(".json"));
  assertEq(snaps.length, 1, "one pre-compaction snapshot written");
  const snap = JSON.parse(readFileSync(join(snapDir, snaps[0]), "utf8"));
  assert(snap.kind === "pre-compaction-snapshot", "snapshot tagged");
  assert(snap.messages.some((m) => m.role === "assistant" && m.content.includes("A".repeat(50))), "snapshot preserves the full original content");

  // 2. summary + distilled notes persisted
  const sumDir = join(snapDir, "summaries");
  assert(readdirSync(sumDir).some((f) => f.endsWith(".md")), "compaction summary saved");
  const notes = readFileSync(join(dir, ".noir", "memory", "notes.md"), "utf8");
  assert(notes.includes("project uses the NOIR harness"), "distilled NOTE merged into notes.md");

  // 3. session reset to continuation summary
  assertEq(h.session.messages.length, 1, "session reset to a single restore message");
  assert(h.session.messages[0].content.includes("SESSION RESTORED"), "restore marker present");
  assert(h.session.messages[0].content.includes("set up the project"), "summary content in restore message");

  // 4. next turn works from the compacted state
  const ev2 = [];
  for await (const ev of h.chat("continue")) ev2.push(ev);
  const final = ev2.filter((e) => e.type === "message" && e.message.role === "assistant").pop();
  assertEq(final?.message.content, "after compaction reply", "post-compaction turn works");

  // 5. manual /compact via command also snapshots
  await h.compact();
  assertEq(readdirSync(snapDir).filter((f) => f.endsWith(".json")).length, 2, "manual compact wrote second snapshot");

  await h.shutdown();
}
