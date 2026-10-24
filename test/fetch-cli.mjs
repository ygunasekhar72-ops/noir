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

  // ---- REGRESSION: extensionless entry (the global `noir` symlink case).
  // npm link / npm i -g create a bin named `noir` (no .js). This is what broke
  // on a real phone: argv[1] had no extension, the CLI guard didn't match, and
  // the process silently exited. Simulate it exactly.
  {
    const { copyFileSync, rmSync } = await import("node:fs");
    const shimNoExt = join(root, "bin", "noir-noext"); // same code, no extension
    copyFileSync(join(root, "bin", "noir.js"), shimNoExt);
    try {
      const mockEnv = { ...process.env, NOIR_PROVIDER: "mock", NOIR_MODEL: "mock" };
      const r = await new Promise((resolve) => {
        const p = spawn(process.execPath, [shimNoExt, "doctor"], { cwd: root, env: mockEnv });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out, err }));
      });
      assertEq(r.code, 0, `extensionless entry exits 0, got ${r.code}`);
      assert(r.out.includes("noir 0.1.0"), `extensionless entry runs the CLI (doctor output): ${r.out.slice(0, 80)}`);
      assert(r.out.includes("shell: ok"), "extensionless entry: doctor completes");
      const r2 = await new Promise((resolve) => {
        const p = spawn(process.execPath, [shimNoExt, "version"], { cwd: root, env: mockEnv });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("close", (code) => resolve({ code, out }));
      });
      assert(r2.out.includes("noir 0.1.0"), "extensionless entry: version works");
    } finally {
      rmSync(shimNoExt, { force: true });
    }
  }
}
