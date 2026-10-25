import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** `noir selftest` — the automated field-verification engine. */
export async function test() {
  const { runSelfTest, formatSelftest } = await import("../dist/core/selftest.js");

  /* ---- 1. happy path with a mock provider: everything must pass ---- */
  const dir = tmpProject("noir-selftest");
  const h = await makeHarness(dir, { script: [{ text: "ok" }] });
  const report = await runSelfTest(h);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert(report.failed === 0, `no failures, got: ${report.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join("; ")}`);
  assertEq(report.exitCode, 0, "exit code 0 when all green");
  assert(byName["entry point"].ok, "entry point check");
  assert(byName["runtime"].ok, "runtime check");
  assert(byName["build artifacts"].ok, `build artifacts: ${byName["build artifacts"].detail}`);
  assert(byName["tools & skills"].ok, "registries check");
  assert(byName.shell.ok && byName.shell.detail.includes("echo"), "shell check");
  assert(byName["memory workspace"].ok, "memory check");
  assert(byName["local server"].ok, `server check: ${byName["local server"].detail}`);
  assert(byName["TUI module"].ok, "TUI import check");
  assert(byName["AI provider"].ok, "provider check (mock ready)");
  assert(!byName["AI provider"].skipped, "mock provider is not skipped");
  assertEq(byName["web app hosting"].skipped, true, "webapp check skipped when none installed");

  const text = formatSelftest(report);
  assert(text.includes("NOIR selftest —"), "format header");
  assert(text.includes("selftest PASSED"), "format verdict");
  assert(text.split("\n").filter((l) => l.includes("[✓]")).length >= 8, "checklist marks rendered");

  /* ---- 2. no API key: provider check skips, everything else still passes ----
     (CI sets NOIR_PROVIDER=mock globally, so we force a keyless provider
     explicitly via configOverrides — deterministic on every platform) */
  const dir2 = tmpProject("noir-selftest-nokey");
  const { Harness } = await import("../dist/core/harness.js");
  const h2 = await Harness.create({
    projectDir: dir2,
    loadModules: false,
    connectMcp: false,
    configOverrides: { logging: { level: "silent" }, provider: "openai", apiKey: undefined },
  });
  await h2.modulesReady;
  const report2 = await runSelfTest(h2);
  const byName2 = Object.fromEntries(report2.results.map((r) => [r.name, r]));
  assertEq(report2.exitCode, 0, "missing API key is not a selftest failure");
  assertEq(byName2["AI provider"].skipped, true, `provider skipped without key (detail: ${byName2["AI provider"].detail})`);
  assertEq(report2.failed, 0, "rest of install still verified");

  /* ---- 3. webapp installed -> hosting check actually runs ---- */
  const dir3 = tmpProject("noir-selftest-app");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  execFileSync(process.execPath, [fileURLToPath(new URL("../examples/noir-pad/install.mjs", import.meta.url)), dir3], { stdio: "pipe" });
  const h3 = await makeHarness(dir3, { script: [{ text: "ok" }] });
  const report3 = await runSelfTest(h3);
  const byName3 = Object.fromEntries(report3.results.map((r) => [r.name, r]));
  assertEq(byName3["web app hosting"].skipped, false, "webapp check runs when installed");
  assert(byName3["web app hosting"].ok && byName3["web app hosting"].detail.includes("noirpad"), `webapp check detail: ${byName3["web app hosting"].detail}`);

  /* ---- 4. failure propagation: a broken check must fail the report ---- */
  const h4 = await makeHarness(tmpProject("noir-selftest-broken"), { script: [{ text: "ok" }] });
  const realRunShell = h4.runShell.bind(h4);
  h4.runShell = async () => ({ output: "", exitCode: 127, timedOut: false }); // simulate broken shell
  const report4 = await runSelfTest(h4);
  assert(report4.failed >= 1, "broken shell fails the report");
  assertEq(report4.exitCode, 1, "exit code 1 on failure");
  const text4 = formatSelftest(report4);
  assert(text4.includes("FAILED"), "format marks failures");
  h4.runShell = realRunShell;

  await h.shutdown();
  await h2.shutdown();
  await h3.shutdown();
  await h4.shutdown();
}
