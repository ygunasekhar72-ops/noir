import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Plugin & extension loader battery: module shapes, failure isolation, npm layouts. */
export async function test() {
  const dir = tmpProject("noir-mods");

  // 1. CJS plugin (.cjs)
  mkdirSync(join(dir, ".noir", "plugins", "cjsplugin"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "cjsplugin", "plugin.cjs"),
    `module.exports = {
  name: "cjsplugin",
  setup(ctx) { ctx.registerCommand({ name: "cjscmd", description: "cjs command", run: () => "CJS-OK" }); }
};`
  );

  // 2. plugin that throws in setup -> isolated, harness continues
  mkdirSync(join(dir, ".noir", "plugins", "bomber"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "bomber", "plugin.mjs"),
    `export default { name: "bomber", setup() { throw new Error("setup exploded"); } };`
  );

  // 3. npm-style package with package.json main
  mkdirSync(join(dir, ".noir", "plugins", "packaged", "lib"), { recursive: true });
  writeFileSync(join(dir, ".noir", "plugins", "packaged", "package.json"), JSON.stringify({ name: "packaged-plugin", version: "2.1.0", main: "lib/entry.js", type: "module" }));
  writeFileSync(
    join(dir, ".noir", "plugins", "packaged", "lib", "entry.js"),
    `export default { name: "packaged", version: "2.1.0", setup(ctx) { ctx.registerTool({ name: "packaged_tool", description: "from package", parameters: { type: "object" }, run: () => "PACKAGED-OK" }); } };`
  );

  // 4. contribution wrapper style { command: {...} }
  mkdirSync(join(dir, ".noir", "extensions", "wrapped"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "extensions", "wrapped", "extension.mjs"),
    `export default {
  name: "wrapped",
  contributions: {
    commands: [{ command: { name: "wrappedcmd", description: "wrapped", run: () => "WRAPPED-OK" } }],
    panels: [{ panel: { id: "wrappedpanel", title: "Wrapped", render: () => "WRAPPED-PANEL" } }],
  },
};`
  );

  // 5. invalid module (no setup/contributions) -> recorded as error, no crash
  mkdirSync(join(dir, ".noir", "plugins", "junk"), { recursive: true });
  writeFileSync(join(dir, ".noir", "plugins", "junk", "plugin.mjs"), `export const whatever = 42;`);

  // 6. async setup resolves
  mkdirSync(join(dir, ".noir", "plugins", "asyncplugin"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "asyncplugin", "plugin.mjs"),
    `export default { name: "asyncplugin", async setup(ctx) {
    await new Promise(r => setTimeout(r, 20));
    ctx.registerCommand({ name: "asynccmd", description: "async", run: () => "ASYNC-OK" });
  } };`
  );

  // 7. plugin with panel registration via setup (registerPanel)
  mkdirSync(join(dir, ".noir", "plugins", "panelplugin"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "panelplugin", "plugin.mjs"),
    `export default { name: "panelplugin", setup(ctx) { ctx.registerPanel({ id: "setuppanel", title: "Setup Panel", render: () => "SETUP-PANEL-BODY" }); } };`
  );

  const h = await makeHarness(dir, { loadModules: true, script: [{ text: "ok" }] });
  await h.modulesReady;

  // cjs works
  assertEq(await h.commands.get("cjscmd").run([], h), "CJS-OK", "cjs plugin command");
  // bomber isolated: harness alive, no bomber tools
  assert(!h.tools.has("bomber"), "bomber registered nothing");
  // packaged plugin loaded via package.json main
  const pr = await h.tools.execute("packaged_tool", {}, h.makeCtx(h.session));
  assert(!pr.isError && pr.content === "PACKAGED-OK", `npm-layout plugin tool: ${pr.content}`);
  // wrapped contributions
  assertEq(await h.commands.get("wrappedcmd").run([], h), "WRAPPED-OK", "wrapper-style command");
  assertEq(await h.panels.get("wrappedpanel").render(h), "WRAPPED-PANEL", "wrapper-style panel");
  // async setup
  assertEq(await h.commands.get("asynccmd").run([], h), "ASYNC-OK", "async setup command");
  // setup-registered panel
  assertEq(await h.panels.get("setuppanel").render(h), "SETUP-PANEL-BODY", "setup-registered panel");

  // plugin event hook wiring
  let hookFired = 0;
  mkdirSync(join(dir, ".noir", "plugins", "hooked"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "hooked", "plugin.mjs"),
    `export default { name: "hooked", setup(ctx) { ctx.on("tool:end", () => { globalThis.__hookCount = (globalThis.__hookCount || 0) + 1; }); } };`
  );
  const h2 = await makeHarness(dir, { loadModules: true, script: [{ toolCalls: [{ id: "t", name: "task_board", arguments: { action: "list" } }] }, { text: "done" }] });
  for await (const _ of h2.chat("fire a tool")) void _;
  assert((globalThis.__hookCount ?? 0) >= 1, "plugin hook received tool:end events");
  delete globalThis.__hookCount;
  await h2.shutdown();

  // plugin tool overriding a builtin name (later registration wins, no crash)
  mkdirSync(join(dir, ".noir", "plugins", "overrider"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "overrider", "plugin.mjs"),
    `export default { name: "overrider", setup(ctx) { ctx.registerTool({ name: "list_skills", description: "overridden list", parameters: { type: "object" }, run: () => "OVERRIDDEN" }); } };`
  );
  const h3 = await makeHarness(dir, { loadModules: true, script: [{ text: "ok" }] });
  const r3 = await h3.tools.execute("list_skills", {}, h3.makeCtx(h3.session));
  assert(r3.content === "OVERRIDDEN", "plugin can override builtin tool (documented escape hatch)");
  await h3.shutdown();

  await h.shutdown();
}
