import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a throwaway project dir. */
export function tmpProject(name = "noir-test") {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(dir, ".noir"), { recursive: true });
  return dir;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

export function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`assert failed: ${msg} — expected ${JSON.stringify(expected)?.slice(0, 200)}, got ${JSON.stringify(actual)?.slice(0, 200)}`);
  }
}

export async function makeHarness(projectDir, opts = {}) {
  const { Harness } = await import("../dist/core/harness.js");
  const { MockProvider } = await import("../dist/core/providers/index.js");
  const provider = opts.provider ?? new MockProvider(opts.script ?? []);
  const h = await Harness.create({
    projectDir,
    provider,
    model: "mock-model",
    loadModules: opts.loadModules ?? false,
    connectMcp: false,
    configOverrides: { logging: { level: "silent" }, ...(opts.config ?? {}) },
  });
  await h.modulesReady;
  return h;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
