import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Full agent loop with the mock provider: tool call -> tool result -> final text. */
export async function test() {
  const dir = tmpProject();
  const h = await makeHarness(dir, {
    script: [
      {
        toolCalls: [
          { id: "t1", name: "write_file", arguments: { path: "out.txt", content: "hello noir" } },
          { id: "t2", name: "task_board", arguments: { action: "add", title: "write the file" } },
        ],
      },
      { toolCalls: [{ id: "t3", name: "unknown_tool", arguments: {} }] },
      { text: "File written and task tracked." },
    ],
  });

  const events = [];
  for await (const ev of h.chat("create out.txt")) {
    events.push(ev);
  }

  assert(existsSync(join(dir, "out.txt")), "agent wrote the file");
  assertEq(readFileSync(join(dir, "out.txt"), "utf8"), "hello noir", "file content");
  assertEq(h.session.taskBoard.length, 1, "task board persisted");

  const assistantTexts = events.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message.content);
  assertEq(assistantTexts.length, 3, "3 assistant turns");
  assertEq(assistantTexts[2], "File written and task tracked.", "final text");

  const toolEnds = events.filter((e) => e.type === "tool" && e.phase === "end");
  assertEq(toolEnds.length, 3, "3 tool executions");
  assert(toolEnds.some((e) => e.name === "unknown_tool" && e.ok === false), "unknown tool -> error result, loop survives");

  const done = events.find((e) => e.type === "done");
  assertEq(done?.reason, "end", "clean done");

  // session persisted to .noir/sessions
  assert(h.listSessions().length >= 1, "session saved on disk");
  await h.shutdown();
}
