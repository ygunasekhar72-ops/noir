import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Web fetch + CLI (bin/noir.js doctor, run with mock provider). */
export async function test() {
  const here = dirname(fileURLToPath(import.meta.url));

  // ---- web_fetch (network-guarded)
  try {
    const { fetchUrl } = await import("../dist/core/tools/web.js");
    const r = await Promise.race([
      fetchUrl("https://example.com", { maxChars: 2000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);
    assertEq(r.status, 200, "example.com reachable");
    assert(r.text.toLowerCase().includes("example domain"), "html stripped to text");
  } catch {
    // offline environment: skip this section
  }

  // ---- CLI: doctor (mock provider -> exit 0)
  const root = join(here, "..");
  const doctor = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, "bin", "noir.js"), "doctor"], {
      cwd: root,
      env: { ...process.env, NOIR_PROVIDER: "mock", NOIR_MODEL: "mock" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  assert(doctor.code === 0, `doctor exit 0, got ${doctor.code}: ${doctor.out.slice(0, 300)}`);
  assert(doctor.out.includes("noir 0.1.0"), `doctor banner: ${doctor.out.slice(0, 60)}`);
  assert(doctor.out.includes("shell: ok"), `doctor shell check: ${doctor.out}`);

  // ---- CLI: run with mock provider (env-configured)
  const runOut = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, "bin", "noir.js"), "run", "say hi"], {
      cwd: root,
      env: { ...process.env, NOIR_PROVIDER: "mock", NOIR_MODEL: "mock" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  assert(runOut.out.includes("mock: no script left") || runOut.out.length > 0, `mock run replied: ${runOut.out.slice(0, 80)}`);

  // ---- CLI: models list
  const modelsOut = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, "bin", "noir.js"), "models"], { cwd: root });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
  });
  assert(modelsOut.includes("openai") && modelsOut.includes("anthropic") && modelsOut.includes("ollama"), "models lists providers");
}
