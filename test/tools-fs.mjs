import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, tmpProject } from "./helpers.mjs";

/** Built-in file tools: read/write/edit/list/search round-trip. */
export async function test() {
  const dir = tmpProject();
  const { registerBuiltinTools, ToolRegistry } = await import("../dist/core/tools/index.js");
  const { Harness } = await import("../dist/core/harness.js");
  const h = await Harness.create({ projectDir: dir, loadModules: false, connectMcp: false, provider: undefined });
  // NOTE: provider undefined -> createProvider("openai") throws -> provider null; fine for tool tests.
  const ctx = h.makeCtx(h.session);

  const reg = new ToolRegistry();
  registerBuiltinTools(reg);

  // write_file
  let r = await reg.execute("write_file", { path: "src/app.txt", content: "alpha\nbeta\ngamma\n" }, ctx);
  assert(!r.isError, `write_file: ${r.content}`);
  assert(existsSync(join(dir, "src", "app.txt")), "file created");

  // read_file
  r = await reg.execute("read_file", { path: "src/app.txt" }, ctx);
  assert(!r.isError, `read_file: ${r.content}`);
  assert(r.content.includes("1| alpha"), `numbered lines: ${r.content.slice(0, 80)}`);
  assert(r.content.includes("(3 lines total)"), `total lines note: ${r.content}`);

  // edit_file unique
  r = await reg.execute("edit_file", { path: "src/app.txt", oldString: "beta", newString: "BETA" }, ctx);
  assert(!r.isError && r.content.startsWith("OK"), `edit_file: ${r.content}`);
  assertEq(readFileSync(join(dir, "src", "app.txt"), "utf8"), "alpha\nBETA\ngamma\n", "edit applied");

  // edit_file not found
  r = await reg.execute("edit_file", { path: "src/app.txt", oldString: "nope", newString: "x" }, ctx);
  assert(r.isError, "edit_file should fail on missing string");

  // edit_file ambiguous
  writeFileSync(join(dir, "dup.txt"), "x x x\n", "utf8");
  r = await reg.execute("edit_file", { path: "dup.txt", oldString: "x", newString: "y" }, ctx);
  assert(r.isError && r.content.includes("3 times"), `ambiguous detection: ${r.content}`);
  r = await reg.execute("edit_file", { path: "dup.txt", oldString: "x", newString: "y", replaceAll: true }, ctx);
  assert(!r.isError, `replaceAll: ${r.content}`);
  assertEq(readFileSync(join(dir, "dup.txt"), "utf8"), "y y y\n", "replaceAll applied");

  // list_files glob
  r = await reg.execute("list_files", { pattern: "**/*.txt" }, ctx);
  assert(!r.isError && r.content.includes("src/app.txt") && r.content.includes("dup.txt"), `glob: ${r.content}`);

  // search_files regex + literal
  r = await reg.execute("search_files", { pattern: "BETA" }, ctx);
  assert(!r.isError && r.content.includes("src/app.txt:2:"), `grep: ${r.content}`);
  r = await reg.execute("search_files", { pattern: "y y", literal: true, include: "*.txt" }, ctx);
  assert(r.content.includes("dup.txt:1:"), `literal+include: ${r.content}`);
  r = await reg.execute("search_files", { pattern: "BETA", include: "*.md" }, ctx);
  assert(r.content.includes("0 match(es)"), `include filter excludes: ${r.content}`);

  // run_command
  r = await reg.execute("run_command", { command: `node -e "console.log('shell-ok')"` }, ctx);
  assert(!r.isError && r.content.includes("shell-ok"), `run_command: ${r.content.slice(0, 120)}`);

  // binary rejection
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  r = await reg.execute("read_file", { path: "bin.dat" }, ctx);
  assert(r.isError && r.content.includes("binary"), `binary rejection: ${r.content}`);

  await h.shutdown();
}
