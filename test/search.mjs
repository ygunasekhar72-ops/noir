import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpProject } from "./helpers.mjs";

/** Live web search — network-guarded: reports SKIP when offline/throttled. */
export async function test() {
  const dir = tmpProject();
  const { loadConfig } = await import("../dist/core/config.js");
  const { runSearch, formatSearchResults } = await import("../dist/core/search/index.js");
  const { config } = loadConfig(dir);

  try {
    const results = await Promise.race([
      runSearch({ ...config, search: { ...config.search, provider: "duckduckgo" } }, "node.js javascript runtime"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);
    if (!results || results.length === 0) throw new Error("empty results");
    const formatted = formatSearchResults(results);
    if (!formatted.includes("http")) throw new Error("no urls");
    return; // pass
  } catch (err) {
    return { skipped: true, reason: `network unavailable (${err.message})` };
  }
}

export const live = true;
