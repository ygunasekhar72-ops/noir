import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assert, assertEq, makeHarness, tmpProject } from "./helpers.mjs";

/**
 * Project web apps: hosting (/apps/<name>/), the app-data API (read/write/
 * delete/list), sandboxing, and agent interop (notes are plain project files).
 * Also installs the real NoirPad app and verifies it end to end.
 */
export async function test() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");

  const dir = tmpProject("noir-webapps");
  const h = await makeHarness(dir, { script: [{ text: "ok" }] });

  // ---- install the real NoirPad app (the shipped installer)
  const { execFileSync: run } = await import("node:child_process");
  run(process.execPath, [join(root, "examples", "noir-pad", "install.mjs"), dir], { stdio: "pipe" });
  assert(existsSync(join(dir, ".noir", "webapps", "noirpad", "index.html")), "installer copied the app");
  assert(existsSync(join(dir, ".noir", "webapps", "noirpad", "data", "index.json")), "installer created data dir + index");

  const { startServer } = await import("../dist/server/server.js");
  const server = await startServer(h, { host: "127.0.0.1", port: 0 });
  const base = server.url;

  // ---- state lists the webapp
  const st = await (await fetch(`${base}/api/state`)).json();
  assertEq(JSON.stringify(st.webapps), '["noirpad"]', "state lists installed webapp");

  // ---- static hosting
  let res = await fetch(`${base}/apps/noirpad/`);
  assertEq(res.status, 200, "app index served");
  const html = await res.text();
  assert(html.includes("NoirPad") && html.includes("app.js"), "noirpad index served with brand");
  res = await fetch(`${base}/apps/noirpad/styles.css`);
  assertEq(res.status, 200, "app asset served");
  assert((await res.text()).includes("--bg: #000"), "app stylesheet is monochrome");
  res = await fetch(`${base}/apps/noirpad/app.js`);
  assertEq(res.status, 200, "app js served");
  res = await fetch(`${base}/apps/ghost/`);
  assertEq(res.status, 404, "unknown app 404s");
  res = await fetch(`${base}/apps/noirpad/../harness.ts`);
  assert(res.status === 404 || res.status === 400, "traversal via /apps blocked");
  res = await fetch(`${base}/apps/noirpad/%2e%2e%2findex.html`);
  assertEq(res.status, 400, "encoded traversal rejected");
  res = await fetch(`${base}/apps/harness.ts`);
  assertEq(res.status, 404, "invalid app name 404s (no SPA fallback for /apps/*)");
  // fetch normalizes /apps/x/../../package.json to /package.json — the SPA shell
  // fallback serves index.html; assert NO file disclosure happened
  res = await fetch(`${base}/apps/noirpad/../../package.json`);
  const leakCheck = await res.text();
  assert(!leakCheck.includes('"name"') && !leakCheck.includes("noir-harness"), "no package.json disclosure via normalized traversal");
  res = await fetch(`${base}/apps/NOIRPAD/`);
  assertEq(res.status, 200, "app names are case-insensitive");

  // ---- app-data API: the note lifecycle (as NoirPad performs it)
  const noteMd = "---\ntitle: Shopping list\ntags: errands\nupdated: 2026-10-24T00:00:00.000Z\n---\n\n- milk\n- eggs\n";
  res = await fetch(`${base}/api/app-data/noirpad`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "notes/shopping-list-ab12.md", content: noteMd }),
  });
  assertEq(res.status, 200, "note written via app-data");
  assert(existsSync(join(dir, ".noir", "webapps", "noirpad", "data", "notes", "shopping-list-ab12.md")), "note is a real project file");

  res = await fetch(`${base}/api/app-data/noirpad?file=notes/shopping-list-ab12.md`);
  const read = await res.json();
  assertEq(read.content, noteMd, "note reads back byte-exact");

  res = await fetch(`${base}/api/app-data/noirpad?list=1`);
  const list = await res.json();
  assert(list.files.some((f) => f.file === "notes/shopping-list-ab12.md"), "list includes the note");
  assert(list.files.some((f) => f.file === "index.json"), "list includes the index");

  // index.json maintenance (as NoirPad does)
  await fetch(`${base}/api/app-data/noirpad`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      file: "index.json",
      content: JSON.stringify({ notes: [{ slug: "shopping-list-ab12", title: "Shopping list", tags: ["errands"], updated: "2026-10-24T00:00:00.000Z" }] }, null, 2),
    }),
  });
  res = await fetch(`${base}/api/app-data/noirpad?file=index.json`);
  const idx = JSON.parse((await res.json()).content);
  assertEq(idx.notes.length, 1, "index maintained");

  // ---- sandboxing
  res = await fetch(`${base}/api/app-data/noirpad?file=../evil.txt`);
  assertEq(res.status, 400, "app-data traversal blocked");
  res = await fetch(`${base}/api/app-data/noirpad?file=%2e%2e%2fevil.txt`);
  assertEq(res.status, 400, "encoded app-data traversal blocked");
  res = await fetch(`${base}/api/app-data/noirpad?file=C:/Windows/win.ini`);
  assert(res.status === 400 || res.status === 404, "absolute path blocked");
  res = await fetch(`${base}/api/app-data/noirpad?file=notes/../../../../../etc/passwd`);
  assert(res.status === 400 || res.status === 404, "deep traversal blocked");
  res = await fetch(`${base}/api/app-data/noirpad`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "../../evil.txt", content: "x" }),
  });
  assertEq(res.status, 400, "app-data write traversal blocked");
  assert(!existsSync(join(dir, "..", "evil.txt")), "nothing written outside");
  res = await fetch(`${base}/api/app-data/bad_name!`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "x", content: "y" }),
  });
  assert(res.status === 400 || res.status === 404, "invalid app name rejected");
  res = await fetch(`${base}/api/app-data/noirpad`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "big.bin", content: "B".repeat(513 * 1024) }),
  });
  assertEq(res.status, 413, "512KB size cap enforced");

  // ---- agent interop: the agent reads the phone-made note with its file tools
  const ctx = h.makeCtx(h.session);
  const r = await h.tools.execute("read_file", { path: ".noir/webapps/noirpad/data/notes/shopping-list-ab12.md" }, ctx);
  assert(!r.isError, `agent reads NoirPad notes: ${r.content.slice(0, 60)}`);
  assert(r.content.includes("Shopping list") && r.content.includes("milk"), "note content visible to the agent");
  const g = await h.tools.execute("search_files", { pattern: "milk", include: "**/*.md" }, ctx);
  assert(g.content.includes("shopping-list-ab12.md"), "agent can grep notes");

  // agent writes a note; the app sees it on next list
  const agentNote = "---\ntitle: From the agent\ntags: noir\nupdated: 2026-10-24T01:00:00.000Z\n---\n\nWritten by NOIR itself.\n";
  const w = await h.tools.execute("write_file", { path: ".noir/webapps/noirpad/data/notes/from-agent-xy99.md", content: agentNote }, ctx);
  assert(!w.isError, "agent writes a note");
  res = await fetch(`${base}/api/app-data/noirpad?file=notes/from-agent-xy99.md`);
  assertEq(res.status, 200, "app can read agent-written note");
  assert((await res.json()).content.includes("Written by NOIR itself."), "agent note content round-trips");

  // ---- delete via API
  res = await fetch(`${base}/api/app-data/noirpad?file=notes/from-agent-xy99.md`, { method: "DELETE" });
  assertEq(res.status, 200, "app-data delete");
  assert(!existsSync(join(dir, ".noir", "webapps", "noirpad", "data", "notes", "from-agent-xy99.md")), "deleted file gone");
  res = await fetch(`${base}/api/app-data/noirpad?file=notes/from-agent-xy99.md`);
  assertEq(res.status, 404, "deleted note 404s");

  // ---- shipped app files are syntactically valid
  for (const f of ["app.js", "styles.css", "index.html"]) {
    const src = readFileSync(join(root, "examples", "noir-pad", "www", f), "utf8");
    assert(src.length > 500, `${f} non-trivial`);
  }
  try {
    execFileSync(process.execPath, ["--check", join(root, "examples", "noir-pad", "www", "app.js")], { stdio: "pipe" });
    assert(true, "noirpad app.js syntax valid");
  } catch (err) {
    assert(false, `noirpad app.js syntax error: ${err.message}`);
  }
  try {
    execFileSync(process.execPath, ["--check", join(root, "examples", "noir-pad", "install.mjs")], { stdio: "pipe" });
    assert(true, "installer syntax valid");
  } catch (err) {
    assert(false, `installer syntax error: ${err.message}`);
  }

  await server.close();
  await h.shutdown();
}
