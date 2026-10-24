import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEq, tmpProject } from "./helpers.mjs";

/** Config precedence, deep-merge semantics, env resolution, corruption resilience. */
export async function test() {
  const savedEnv = { ...process.env };
  const home = tmpProject("noir-cfg-home");
  const proj = tmpProject("noir-cfg-proj");

  const loadIn = (projectDir, env = {}) => {
    // snapshot & patch env, but always keep NOIR_HOME (the test fixture home)
    const keep = process.env.NOIR_HOME;
    for (const k of Object.keys(process.env)) if (k.startsWith("NOIR_") || /_API_KEY$/.test(k)) delete process.env[k];
    process.env.NOIR_HOME = keep ?? env.NOIR_HOME ?? home;
    Object.assign(process.env, env);
    return import("../dist/core/config.js").then((m) => m.loadConfig(projectDir));
  };

  /* ---- 1. pure defaults ---- */
  let r = await loadIn(proj, {});
  assertEq(r.config.model, "gpt-4o-mini", "default model");
  assertEq(r.config.compactAtTokens, 60000, "default compact threshold");
  assertEq(r.sources.length, 0, "no sources with fresh dirs");

  /* ---- 2. global config layer ---- */
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "g-global", search: { provider: "brave", maxResults: 5 } }));
  process.env.NOIR_HOME = home;
  r = await loadIn(proj, {});
  assertEq(r.config.model, "g-global", "global model wins over default");
  assertEq(r.config.compactAtTokens, 60000, "unspecified keys keep defaults");
  assertEq(r.sources.length, 1, "global source recorded");

  /* ---- 3. project layer + deep merge (not replace) ---- */
  mkdirSync(join(proj, ".noir"), { recursive: true });
  writeFileSync(join(proj, ".noir", "config.json"), JSON.stringify({ model: "g-project", search: { tavilyKey: "tv-123" } }));
  r = await loadIn(proj, {});
  assertEq(r.config.model, "g-project", "project wins over global");
  assertEq(r.config.search.provider, "brave", "nested merge: global search.provider survives");
  assertEq(r.config.search.tavilyKey, "tv-123", "nested merge: project key added");
  assertEq(r.config.search.maxResults, 5, "nested merge: global scalar survives");
  assertEq(r.sources.length, 2, "both sources recorded");

  /* ---- 4. env beats everything ---- */
  r = await loadIn(proj, { NOIR_MODEL: "g-env", NOIR_PROVIDER: "groq", GROQ_API_KEY: "grog-xyz" });
  assertEq(r.config.model, "g-env", "NOIR_MODEL beats configs");
  assertEq(r.config.provider, "groq", "NOIR_PROVIDER");
  assertEq(r.config.apiKey, "grog-xyz", "provider env key auto-filled as apiKey");

  /* ---- 5. provider-specific env resolution ---- */
  const { resolveApiKey } = await import("../dist/core/config.js");
  process.env.GEMINI_API_KEY = "gem-1";
  assertEq(resolveApiKey(r.config, "google"), "gem-1", "GEMINI_API_KEY for google");
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = "gem-2";
  assertEq(resolveApiKey(r.config, "google"), "gem-2", "GOOGLE_API_KEY fallback");
  delete process.env.GOOGLE_API_KEY;
  assertEq(resolveApiKey(r.config, "google"), undefined, "absent key -> undefined");

  /* ---- 6. per-provider override beats env ---- */
  const cfgWithOverride = { ...r.config, apiKey: undefined, providers: { openai: { apiKey: "stored-key" } } };
  process.env.OPENAI_API_KEY = "env-key";
  assertEq(resolveApiKey(cfgWithOverride, "openai"), "stored-key", "config.providers beats env");
  const cfgGeneric = { ...r.config, provider: "openai", apiKey: "generic", providers: {} };
  assertEq(resolveApiKey(cfgGeneric, "openai"), "generic", "generic apiKey for active provider");
  delete process.env.OPENAI_API_KEY;

  /* ---- 7. corrupt configs ignored ---- */
  writeFileSync(join(home, "config.json"), "{corrupt!!");
  writeFileSync(join(proj, ".noir", "config.json"), "not json at all");
  r = await loadIn(proj, {});
  assertEq(r.config.model, "gpt-4o-mini", "corrupt configs fall back to defaults");

  /* ---- 8. non-object config ignored ---- */
  writeFileSync(join(proj, ".noir", "config.json"), "[1,2,3]");
  r = await loadIn(proj, {});
  assertEq(r.config.provider, "openai", "array config rejected");

  /* ---- 9. writeSampleConfig round trip ---- */
  const { writeSampleConfig, loadConfig, deepMerge, DEFAULT_CONFIG } = await import("../dist/core/config.js");
  rmSync(join(proj, ".noir", "config.json"), { force: true });
  const path = writeSampleConfig(proj, "project");
  assert(existsSync(path), "sample written");
  r = loadConfig(proj);
  assertEq(r.config.model, "gpt-4o-mini", "sample model");
  assert(r.config.mcpServers.filesystem, "sample has mcp example");

  /* ---- 10. deepMerge semantics ---- */
  const merged = deepMerge({ a: { x: 1, y: 2 }, b: [1, 2], c: "keep" }, { a: { y: 3 }, b: [9], d: "new" });
  assertEq(JSON.stringify(merged), JSON.stringify({ a: { x: 1, y: 3 }, b: [9], c: "keep", d: "new" }), "objects merge, arrays replace");
  const noMutate = deepMerge({ a: { x: 1 } }, { a: { x: 2 } });
  assertEq(noMutate.a.x, 2, "merge applied");
  assertEq(deepMerge({ a: 1 }, undefined).a, 1, "merge with undefined");

  /* ---- 11. NOIR_COMPACT_AT_TOKENS env ---- */
  r = await loadIn(proj, { NOIR_COMPACT_AT_TOKENS: "12345" });
  assertEq(r.config.compactAtTokens, 12345, "env threshold override");
  r = await loadIn(proj, { NOIR_COMPACT_AT_TOKENS: "not-a-number" });
  assertEq(r.config.compactAtTokens, 60000, "invalid env ignored");

  /* ---- 12. save round trips ---- */
  const { saveProjectConfig, saveGlobalConfig } = await import("../dist/core/config.js");
  process.env.NOIR_HOME = home;
  const toSave = { ...DEFAULT_CONFIG, model: "saved-model", providers: { openai: { apiKey: "k" } } };
  saveProjectConfig(proj, toSave);
  r = loadConfig(proj);
  assertEq(r.config.model, "saved-model", "project save round trip");
  assertEq(r.config.providers.openai.apiKey, "k", "nested provider saved");
  saveGlobalConfig(toSave);
  assert(existsSync(join(home, "config.json")), "global save");
  writeFileSync(join(home, "config.json"), "{}");

  /* ---- 13. REGRESSION: env must never pollute DEFAULT_CONFIG ---- */
  const before = JSON.stringify(DEFAULT_CONFIG);
  await loadIn(proj, { NOIR_MODEL: "pollution-check", NOIR_PROVIDER: "mock", NOIR_COMPACT_AT_TOKENS: "777" });
  assertEq(JSON.stringify(DEFAULT_CONFIG), before, "DEFAULT_CONFIG untouched by env");
  rmSync(join(proj, ".noir", "config.json"), { force: true }); // remove saved project config
  writeFileSync(join(home, "config.json"), "{}"); // and global
  r = await loadIn(proj, {});
  assertEq(r.config.model, "gpt-4o-mini", "second load unaffected by earlier env");
  assertEq(r.config.compactAtTokens, 60000, "second load threshold unaffected");
  r = await loadIn(proj, { NOIR_MODEL: "again" });
  r = await loadIn(proj, {});
  assertEq(r.config.model, "gpt-4o-mini", "repeated loads stay clean");

  // restore env
  for (const k of Object.keys(process.env)) if (k.startsWith("NOIR_") || /_API_KEY$/.test(k)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}
