import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Skills + plugins + extensions: discovery, activation, tool/command/panel registration. */
export async function test() {
  const dir = tmpProject("noir-ski");

  // project skill
  mkdirSync(join(dir, ".noir", "skills", "greet"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "skills", "greet", "SKILL.md"),
    `---
name: greet
description: Greet a person warmly and formally
---
# Greet skill
Always start with "GREETINGS", then use the person's name.`,
    "utf8"
  );

  // project plugin
  mkdirSync(join(dir, ".noir", "plugins", "datetime"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "plugins", "datetime", "plugin.mjs"),
    `export default {
  name: "datetime",
  version: "1.0.0",
  setup(ctx) {
    ctx.registerTool({
      name: "current_time",
      description: "Get the current UTC time",
      parameters: { type: "object", properties: {} },
      run: () => "Current UTC time: 2026-01-01T00:00:00Z",
    });
    ctx.registerCommand({ name: "time", description: "Show time", run: () => "TIME OK" });
  },
};
`,
    "utf8"
  );

  // project extension (panel + command via contributions)
  mkdirSync(join(dir, ".noir", "extensions", "usage-panel"), { recursive: true });
  writeFileSync(
    join(dir, ".noir", "extensions", "usage-panel", "extension.mjs"),
    `export default {
  name: "usage-panel",
  version: "1.0.0",
  contributions: {
    commands: [{ name: "usage", description: "Usage stats", run: () => "USAGE OK" }],
    panels: [{ id: "usage", title: "Usage", render: () => "PANEL CONTENT" }],
  },
};
`,
    "utf8"
  );

  const h = await makeHarness(dir, { loadModules: true, script: [{ text: "ok" }] });

  // skills: project + builtin
  const skillIds = h.skills.list().map((s) => s.id);
  assert(skillIds.includes("greet"), `project skill discovered: ${skillIds.join(",")}`);
  assert(skillIds.includes("code-review"), `builtin skill discovered: ${skillIds.join(",")}`);

  const greet = h.skills.get("greet");
  assertEq(greet?.description, "Greet a person warmly and formally", "frontmatter parsed");
  assert(greet.body.includes("GREETINGS"), "skill body loaded");

  // use_skill tool activates + registers in session
  const ctx = h.makeCtx(h.session);
  const r = await h.tools.execute("use_skill", { name: "greet" }, ctx);
  assert(!r.isError && r.content.includes("GREETINGS"), `use_skill: ${r.content.slice(0, 60)}`);
  assertEq(h.session.activeSkillInstructions.length, 1, "skill marked active for the session");

  // builtin fallback
  const r2 = await h.tools.execute("use_skill", { name: "nope" }, ctx);
  assert(r2.isError, "unknown skill errors cleanly");

  // plugin tool + command
  assert(h.tools.has("current_time"), "plugin tool registered");
  const r3 = await h.tools.execute("current_time", {}, ctx);
  assert(!r3.isError && r3.content.includes("UTC"), `plugin tool executes: ${r3.content}`);
  assertEq(await h.commands.get("time").run([], h), "TIME OK", "plugin command executes");

  // extension panel + command
  assert(h.panels.has("usage"), "extension panel registered");
  assertEq(await h.panels.get("usage").render(h), "PANEL CONTENT", "panel renders");
  assertEq(await h.commands.get("usage").run([], h), "USAGE OK", "extension command executes");

  await h.shutdown();
}
