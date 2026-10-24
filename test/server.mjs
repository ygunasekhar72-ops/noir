import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/** Mobile app server: static PWA + REST/SSE API end-to-end. */
export async function test() {
  const dir = tmpProject();
  const h = await makeHarness(dir, {
    script: [
      { toolCalls: [{ id: "t1", name: "task_board", arguments: { action: "add", title: "server test" } }] },
      { text: "server reply ok" },
    ],
  });

  const { startServer } = await import("../dist/server/server.js");
  const handle = await startServer(h, { host: "127.0.0.1", port: 0 });
  const base = handle.url;
  assertEq(handle.token, null, "loopback needs no token");

  // ---- static PWA
  const html = await (await fetch(`${base}/`)).text();
  assert(html.includes("NOIR") && html.includes("app.js"), "index.html served");
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).text();
  assert(manifest.includes('"display": "standalone"'), "manifest served");
  const css = await (await fetch(`${base}/styles.css`)).text();
  assert(css.includes("--bg: #000000"), "monochrome stylesheet served");
  const iconsOk = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web", "icons", "icon-192.png"));
  if (iconsOk) {
    const icon = await fetch(`${base}/icons/icon-192.png`);
    assertEq(icon.status, 200, "PWA icon served");
  }

  // ---- /api/state
  const st = await (await fetch(`${base}/api/state`)).json();
  assert(st.version, "state version");
  assert(st.tools.includes("read_file") && st.tools.includes("spawn_subagent"), "tools listed");
  assert(st.agents.some((a) => a.name === "explore"), "agent types listed");
  assert(st.presets && st.presets.openai, "presets included");

  // ---- /api/chat SSE with tool call
  const chatRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "track a task" }),
  });
  assert(chatRes.ok && chatRes.headers.get("content-type").includes("text/event-stream"), "chat is SSE");
  const raw = await chatRes.text();
  const evs = raw
    .split("\n\n")
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice(5).trim()));
  assert(evs.some((e) => e.type === "delta"), "delta events streamed");
  assert(evs.some((e) => e.type === "tool" && e.phase === "start"), "tool start event");
  assert(evs.some((e) => e.type === "tool" && e.phase === "end"), "tool end event");
  assert(evs.some((e) => e.type === "message" && e.message?.content === "server reply ok"), "assistant message event");
  assert(evs.at(-1).type === "done", "done event last");

  // ---- terminal endpoint
  const termRes = await fetch(`${base}/api/terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: `node -e "console.log('term-ok')"` }),
  });
  const termBody = await termRes.text();
  assert(termBody.includes("term-ok"), `terminal output: ${termBody.slice(0, 120)}`);

  // ---- command endpoint + sessions + config masked
  const cmdRes = await (await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "doctor", args: [] }),
  })).json();
  assert(cmdRes.output.includes("noir"), `doctor via API: ${String(cmdRes.output).slice(0, 60)}`);

  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert(Array.isArray(sessions) && sessions.length >= 1, "sessions endpoint");

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert(!JSON.stringify(cfg).match(/sk-[a-zA-Z0-9]{20,}/), "no raw keys leak");

  // ---- panel endpoint
  const panel404 = await fetch(`${base}/api/panel/nope`);
  assertEq(panel404.status, 404, "unknown panel 404s");

  await handle.close();
  await h.shutdown();
}
