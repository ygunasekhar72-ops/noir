import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./config.js";
import { listWebApps } from "./webapps.js";
import { NOIR_VERSION, type Harness } from "./harness.js";

/**
 * `noir selftest` — one-command field verification of an installation
 * (Termux/Android, desktop, CI). Automates what a human would otherwise
 * check by hand: entry point, runtime, build artifacts, registries, shell,
 * memory workspace, local server endpoints, web-app hosting, TUI module.
 * LLM calls are NOT made — the AI provider check is informational (skipped
 * when no key is set), so selftest is always free and offline-safe.
 */

export interface SelftestResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface SelftestReport {
  results: SelftestResult[];
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
}

export async function runSelfTest(h: Harness): Promise<SelftestReport> {
  const results: SelftestResult[] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string] | [boolean, string, true]>): Promise<void> => {
    try {
      const [ok, detail, skipped] = await fn();
      results.push({ name, ok, detail, skipped: skipped === true });
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message });
    }
  };

  /* ---- 1. entry point (the extensionless-symlink case phones hit) ---- */
  await check("entry point", async () => {
    const invoked = process.argv[1] ?? "(unknown)";
    const base = basename(invoked);
    if (base === "noir") return [true, `global command (extensionless) -> ${invoked}`];
    if (/(cli|noir)\.js$/i.test(invoked)) return [true, `direct script -> ${invoked}`];
    return [true, `argv[1] = ${invoked}`];
  });

  /* ---- 2. runtime ---- */
  await check("runtime", async () => {
    const major = parseInt(process.versions.node.split(".")[0], 10);
    const termux = existsSync("/data/data/com.termux");
    const ok = major >= 18;
    return [ok, `node v${process.versions.node} (${process.platform}/${process.arch})${termux ? " — Termux detected" : ""}${ok ? "" : " — NOIR needs node >= 18.17"}`];
  });

  /* ---- 3. build artifacts (the app shell + PWA icons) ---- */
  await check("build artifacts", async () => {
    const web = join(packageRoot(), "dist", "web");
    const need = ["index.html", "app.js", "styles.css", "manifest.webmanifest", "sw.js"];
    for (const f of need) {
      if (!existsSync(join(web, f))) return [false, `missing ${web}/${f} — run npm run build`];
    }
    for (const icon of ["icons/icon-192.png", "icons/icon-512.png"]) {
      const p = join(web, icon);
      if (!existsSync(p)) return [false, `missing ${icon}`];
      const sig = readFileSync(p).readUInt32BE(0);
      if (sig !== 0x89504e47) return [false, `${icon} is not a valid PNG`];
    }
    return [true, `dist/web complete (shell, manifest, service worker, icons 192/512)`];
  });

  /* ---- 4. registries ---- */
  await check("tools & skills", async () => {
    const tools = h.tools.list().length;
    const skills = h.skills.list().length;
    const mcp = h.mcp.listServers().length;
    if (tools < 18) return [false, `only ${tools} tools registered (expected >= 18)`];
    return [true, `${tools} tools · ${skills} skills · ${mcp} MCP server(s)`];
  });

  /* ---- 5. shell execution ---- */
  await check("shell", async () => {
    const r = await h.runShell("echo noir-selftest-shell", () => {}, 15000);
    if (!r.output.includes("noir-selftest-shell")) return [false, `echo produced no output (exit ${r.exitCode})`];
    return [true, "echo + spawn working in this environment"];
  });

  /* ---- 6. memory workspace ---- */
  await check("memory workspace", async () => {
    const probeDir = join(h.projectDir, ".noir", "tmp");
    const probe = join(probeDir, "selftest-probe.txt");
    try {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(probe, "round-trip", "utf8");
      if (readFileSync(probe, "utf8") !== "round-trip") return [false, "write/read mismatch"];
    } finally {
      rmSync(probe, { force: true });
    }
    const notePath = h.memory.appendNote("selftest probe note", "notes");
    const notes = h.memory.readNotes();
    if (!notes.includes("selftest probe note")) return [false, `note round-trip failed (${notePath})`];
    return [true, `${h.memory.dir} writable, notes round-trip ok`];
  });

  /* ---- 7. local server endpoints (no LLM involved) ---- */
  await check("local server", async () => {
    const { startServer } = await import("../server/server.js");
    const handle = await startServer(h, { host: "127.0.0.1", port: 0 });
    try {
      const resIndex = await fetch(`${handle.url}/`);
      if (resIndex.status !== 200) return [false, `GET / -> ${resIndex.status}`];
      const html = await resIndex.text();
      if (!html.includes("NOIR")) return [false, "GET / does not contain the app shell"];
      const resState = await fetch(`${handle.url}/api/state`);
      if (resState.status !== 200) return [false, `GET /api/state -> ${resState.status}`];
      const st = (await resState.json()) as { tools?: string[] };
      if (!Array.isArray(st.tools) || st.tools.length < 18) return [false, "api/state reports no tools"];
      const resManifest = await fetch(`${handle.url}/manifest.webmanifest`);
      if (resManifest.status !== 200) return [false, `GET /manifest.webmanifest -> ${resManifest.status}`];
      const resTerm = await fetch(`${handle.url}/api/terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "echo term-ok" }),
      });
      const termBody = await resTerm.text();
      if (!termBody.includes("term-ok")) return [false, `terminal endpoint: ${termBody.slice(0, 80)}`];
      return [true, `boot on ${handle.url} — / · /api/state · manifest · terminal all ok`];
    } finally {
      await handle.close();
    }
  });

  /* ---- 8. web-app hosting (if the project has webapps) ---- */
  await check("web app hosting", async () => {
    const apps = listWebApps(h.projectDir);
    if (!apps.length) {
      return [true, "none installed (optional — e.g. `node examples/noir-pad/install.mjs .`)", true];
    }
    const { startServer } = await import("../server/server.js");
    const handle = await startServer(h, { host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`${handle.url}/apps/${apps[0]}/`);
      if (res.status !== 200) return [false, `GET /apps/${apps[0]}/ -> ${res.status}`];
      return [true, `${apps.length} app(s): /apps/${apps[0]}/ -> 200`];
    } finally {
      await handle.close();
    }
  });

  /* ---- 9. TUI module loads (Termux renders it for real) ---- */
  await check("TUI module", async () => {
    const tui = join(packageRoot(), "dist", "tui", "app.js");
    if (!existsSync(tui)) return [false, "dist/tui/app.js missing — run npm run build"];
    await import(pathToFileURL(tui).href);
    return [true, "dist/tui/app.js imports cleanly"];
  });

  /* ---- 10. AI provider (informational by default — never spends tokens) ---- */
  await check("AI provider", async () => {
    if (!h.provider) {
      return [true, `${h.providerError ?? "no provider"} — everything above works; add an API key to chat`, true];
    }
    if (process.env.NOIR_SELFTEST_LIVE !== "1") {
      return [true, `${h.config.provider}/${h.model} ready (live call not made — set NOIR_SELFTEST_LIVE=1 to ping it)`];
    }
    const { completeText } = await import("./providers/index.js");
    const out = await completeText(h.provider, h.model, "Reply with exactly: ok", { maxTokens: 16, temperature: 0 });
    if (!out) return [false, `${h.config.provider}/${h.model} answered an empty live response`];
    return [true, `${h.config.provider}/${h.model} LIVE call answered: "${out.slice(0, 40)}"`];
  });

  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return { results, passed, failed, skipped, exitCode: failed === 0 ? 0 : 1 };
}

export function formatSelftest(report: SelftestReport): string {
  const lines: string[] = [];
  lines.push(`NOIR selftest — v${NOIR_VERSION} — ${process.platform}/${process.arch} — node v${process.versions.node}`);
  lines.push("");
  for (const r of report.results) {
    const mark = r.skipped ? "[-]" : r.ok ? "[\u2713]" : "[\u2717]";
    lines.push(` ${mark} ${r.name.padEnd(16)} ${r.detail}`);
  }
  lines.push("");
  lines.push(` ${report.passed} passed · ${report.skipped} skipped · ${report.failed} failed`);
  if (report.failed > 0) lines.push(` selftest FAILED — fix the [✗] items above, then re-run \`noir selftest\``);
  else lines.push(` selftest PASSED — installation verified end to end`);
  return lines.join("\n");
}
