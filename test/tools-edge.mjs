import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { assert, assertEq, assertThrows, tmpProject, makeHarness } from "./helpers.mjs";

/** Deep edge-case battery for every built-in tool. */
export async function test() {
  const dir = tmpProject("noir-edge");
  const h = await makeHarness(dir, { script: [{ text: "ok" }] });
  const ctx = h.makeCtx(h.session);
  const exec = (name, args) => h.tools.execute(name, args, ctx);

  /* ---------- read_file ---------- */
  const lines100 = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  writeFileSync(join(dir, "big.txt"), lines100);
  let r = await exec("read_file", { path: "big.txt", offset: 50, limit: 10 });
  assert(!r.isError, "read_file paging ok");
  assert(r.content.includes("50| line-50"), `paging offset 50: ${r.content.slice(0, 60)}`);
  assert(r.content.includes("59| line-59"), "paging line 59");
  assert(!r.content.includes("line-60|"), "paging respects limit");
  assert(r.content.includes("41 more lines"), `remaining count: ${r.content.slice(-80)}`);

  r = await exec("read_file", { path: "empty.txt" });
  writeFileSync(join(dir, "empty.txt"), "");
  r = await exec("read_file", { path: "empty.txt" });
  assert(!r.isError && r.content.includes("0 lines total"), `empty file: ${r.content}`);

  r = await exec("read_file", { path: "missing.txt" });
  assert(r.isError && r.content.includes("File not found"), "missing file errors");
  mkdirSync(join(dir, "a-dir"));
  r = await exec("read_file", { path: "a-dir" });
  assert(r.isError, "directory read rejected");

  // unicode round trip
  const uni = "héllo wörld 你好世界 🚀emoji\nline-two—emdash\n";
  writeFileSync(join(dir, "uni.txt"), uni, "utf8");
  r = await exec("read_file", { path: "uni.txt" });
  assert(r.content.includes("你好世界") && r.content.includes("🚀"), "unicode content preserved");

  // CRLF file
  writeFileSync(join(dir, "crlf.txt"), "alpha\r\nbeta\r\n");
  r = await exec("read_file", { path: "crlf.txt" });
  assert(!r.isError && r.content.includes("1| alpha") && r.content.includes("2| beta"), "CRLF read: " + r.content.slice(0, 40));
  assert(!r.content.includes("\r"), "CRLF normalized in output");

  // very long single line gets truncated in output (context safety)
  writeFileSync(join(dir, "longline.txt"), "S".repeat(50000) + "\n");
  r = await exec("read_file", { path: "longline.txt" });
  assert(r.content.includes("line truncated, 50000 chars"), "long line truncated with marker");
  assert(r.content.length < 8000, `truncated output stays small: ${r.content.length}`);

  /* ---------- edit_file ---------- */
  r = await exec("edit_file", { path: "crlf.txt", oldString: "alpha\r\nbeta", newString: "ALPHA\r\nBETA" });
  assert(!r.isError, `CRLF edit: ${r.content}`);
  assertEq(readFileSync(join(dir, "crlf.txt"), "utf8"), "ALPHA\r\nBETA\r\n", "CRLF edit preserved endings");

  r = await exec("edit_file", { path: "uni.txt", oldString: "你好世界", newString: "再见世界" });
  assert(!r.isError, "unicode edit");
  assert(readFileSync(join(dir, "uni.txt"), "utf8").includes("再见世界"), "unicode edit applied");

  r = await exec("edit_file", { path: "uni.txt", oldString: "", newString: "x" });
  assert(r.isError, "empty oldString rejected");

  // edit at start and end of file
  writeFileSync(join(dir, "edge.txt"), "START middle END\n");
  r = await exec("edit_file", { path: "edge.txt", oldString: "START", newString: "BEGIN" });
  assert(!r.isError, "edit at start");
  r = await exec("edit_file", { path: "edge.txt", oldString: "END", newString: "FINISH" });
  assert(!r.isError, "edit at end");
  assertEq(readFileSync(join(dir, "edge.txt"), "utf8"), "BEGIN middle FINISH\n", "start/end edits applied");

  /* ---------- project boundary (security) ---------- */
  r = await exec("read_file", { path: "../outside.txt" });
  assert(r.isError && r.content.includes("escapes the project"), `traversal blocked: ${r.content.slice(0, 80)}`);
  r = await exec("write_file", { path: "../../evil.txt", content: "x" });
  assert(r.isError && r.content.includes("escapes the project"), "write traversal blocked");
  assert(!existsSync(join(dir, "..", "evil.txt")), "no file written outside");
  r = await exec("edit_file", { path: "/etc/hosts", oldString: "a", newString: "b" });
  assert(r.isError && r.content.includes("escapes the project"), "absolute path blocked");
  r = await exec("list_files", { pattern: "*.txt", path: ".." });
  assert(r.isError && r.content.includes("escapes the project"), "list traversal blocked");
  r = await exec("search_files", { pattern: "x", path: "../" });
  assert(r.isError && r.content.includes("escapes the project"), "search traversal blocked");
  // inside-project absolute path is fine (resolve clamps to project)
  r = await exec("read_file", { path: join(dir, "edge.txt") });
  assert(!r.isError, "absolute path inside project allowed");

  /* ---------- glob / list_files ---------- */
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export 1\n");
  writeFileSync(join(dir, "src", "deep", "b.tsx"), "export 2\n");
  writeFileSync(join(dir, "README.md"), "# x\n");
  r = await exec("list_files", { pattern: "**/*.ts" });
  assert(r.content.includes("src/a.ts"), "**/*.ts matches nested");
  assert(!r.content.includes("b.tsx"), "*.ts does not match .tsx extension");
  r = await exec("list_files", { pattern: "**/*.tsx" });
  assert(r.content.includes("src/deep/b.tsx"), "**/*.tsx matches nested tsx");
  r = await exec("list_files", { pattern: "*.md" });
  assert(r.content.includes("README.md") && !r.content.includes("src/"), "*.md root-only");
  r = await exec("list_files", { pattern: "src/**" });
  assert(r.content.includes("src/a.ts") && r.content.includes("src/deep/b.tsx"), "src/** subtree");
  r = await exec("list_files", { pattern: "?ebug.txt" });
  assert(!r.content.includes("crlf.txt"), "? wildcard");

  /* ---------- search_files ---------- */
  writeFileSync(join(dir, "multi1.txt"), "foo bar\nbaz FOO\n");
  writeFileSync(join(dir, "multi2.txt"), "nothing here\nfoo again\n");
  writeFileSync(join(dir, "skip.bin"), Buffer.from([0, 1, 2]));
  r = await exec("search_files", { pattern: "foo", caseSensitive: true });
  assert(r.content.includes("multi1.txt:1:") && !r.content.includes("baz FOO"), "case sensitive by default");
  r = await exec("search_files", { pattern: "foo", caseSensitive: false });
  assert(r.content.includes("baz FOO"), "case insensitive option");
  r = await exec("search_files", { pattern: "f[o]{2}", include: "multi1.txt" });
  assert(r.content.includes("multi1.txt:1:"), "include filter narrows");
  r = await exec("search_files", { pattern: "(((" });
  assert(r.isError && r.content.includes("Invalid regex"), "invalid regex handled");
  r = await exec("search_files", { pattern: "a+b", literal: true });
  assert(r.content.includes("0 match(es)"), "literal mode escapes regex chars");

  /* ---------- run_command ---------- */
  r = await exec("run_command", { command: `node -e "process.exit(3)"` });
  assert(r.content.includes("[exit 3]"), "exit code surfaced");
  r = await exec("run_command", { command: `node -e "console.error('to-stderr')"` });
  assert(r.content.includes("to-stderr"), "stderr captured");
  r = await exec("run_command", { command: `node -e "console.log('X'.repeat(300000))"` });
  assert(r.content.includes("truncated"), "huge output truncated");
  r = await exec("run_command", { command: `node -e "setTimeout(()=>{},10000)"`, timeoutMs: 800 });
  assert(r.content.includes("timed out"), "timeout kills command");
  r = await exec("run_command", { command: "cd" });
  assert(!r.isError, "simple command works");

  /* ---------- task_board ---------- */
  r = await exec("task_board", { action: "add", title: "first" });
  assert(r.content.includes("task 1"), `task added id 1 — got: ${r.content.slice(0, 150)}`);
  await exec("task_board", { action: "add", title: "second" });
  r = await exec("task_board", { action: "update", id: "2", status: "doing" });
  assert(r.content.includes("doing"), "task status update");
  r = await exec("task_board", { action: "list" });
  assert(r.content.includes("[~]") && r.content.includes("second"), "board renders doing marker");
  r = await exec("task_board", { action: "update", id: "99", status: "done" });
  assert(r.isError, "update nonexistent task errors");
  r = await exec("task_board", { action: "update", id: "1", status: "bogus" });
  assert(r.isError && r.content.includes("todo|doing|done"), "invalid status rejected");
  r = await exec("task_board", { action: "update", id: "1", status: "done" });
  r = await exec("task_board", { action: "clear" });
  r = await exec("task_board", { action: "list" });
  assert(r.content.includes("empty"), "board cleared");

  /* ---------- web_fetch against a local server ---------- */
  const { server, port } = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head><title>t</title></head><body><script>alert(1)</script><style>a{}</style><h1>Main&nbsp;Title</h1><p>Para one</p><a href='/x'>link</a></body></html>");
      } else if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, n: 42 }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/html" });
        res.end();
      } else if (req.url === "/404") {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<h1>nope</h1>");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain text body");
      }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
  const { fetchUrl } = await import("../dist/core/tools/web.js");

  const page = await fetchUrl(`http://127.0.0.1:${port}/html`);
  assertEq(page.status, 200, "fetch html 200");
  assert(page.text.includes("Main Title"), `entity decoded: ${page.text.slice(0, 40)}`);
  assert(page.text.includes("Para one"), "paragraph text kept");
  assert(!page.text.includes("alert(1)"), "script stripped");
  assert(!page.text.includes("a{}"), "style stripped");
  assert(!page.text.includes("<h1>"), "tags stripped");

  const json = await fetchUrl(`http://127.0.0.1:${port}/json`);
  assert(json.text.includes('"n": 42') || json.text.includes('"n":42'), "json passthrough");

  const redir = await fetchUrl(`http://127.0.0.1:${port}/redirect`);
  assertEq(redir.status, 200, "redirect followed");
  assert(redir.text.includes("Main Title"), "redirect target content");

  r = await exec("web_fetch", { url: `http://127.0.0.1:${port}/404` });
  assert(!r.isError && r.content.includes("Status: 404"), "404 status surfaced in tool result");
  r = await exec("web_fetch", { url: "ftp://bad" });
  assert(r.isError && r.content.includes("http"), "non-http scheme rejected");
  r = await exec("web_fetch", {});
  assert(r.isError, "missing url rejected");
  server.close();

  /* ---------- memory tools ---------- */
  r = await exec("save_memory", { note: "boundary test note" });
  assert(!r.isError, "save_memory ok");
  r = await exec("save_memory", { note: "fact test", kind: "facts" });
  r = await exec("save_memory", { note: "global test", kind: "global" });
  r = await exec("save_memory", { note: "bad", kind: "weird" });
  assert(r.isError, "invalid memory kind rejected");
  r = await exec("save_memory", { note: "" });
  assert(r.isError, "empty note rejected");
  r = await exec("read_memory", {});
  assert(r.content.includes("boundary test note") && r.content.includes("fact test") && r.content.includes("global test"), "read_memory sees all kinds");
  r = await exec("list_snapshots", {});
  assert(!r.isError, "list_snapshots runs");

  /* ---------- skills tools ---------- */
  r = await exec("use_skill", { name: "does-not-exist" });
  assert(r.isError && r.content.includes("Available:"), "unknown skill lists available");
  r = await exec("list_skills", {});
  assert(r.content.includes("code-review"), "builtin skill listed via tool");

  /* ---------- mcp tools (no servers) ---------- */
  r = await exec("list_mcp", {});
  assert(r.content.includes("No MCP servers connected"), "list_mcp helpful when empty");
  r = await exec("call_mcp", { server: "x", tool: "y" });
  assert(r.isError, "call_mcp without server errors");

  /* ---------- role restriction ---------- */
  r = await h.tools.execute("read_file", { path: "edge.txt" }, { ...ctx, session: ctx.session });
  assert(!r.isError, "full-ctx read allowed");
  const restricted = await (async () => {
    const agent = h.subagents.getDef("explore");
    return agent.tools.includes("run_command") === false;
  })();
  assert(restricted, "explore lacks run_command");

  /* ---------- unknown tool & argument fuzz ---------- */
  r = await h.tools.execute("definitely_not_a_tool", {}, ctx);
  assert(r.isError && r.content.includes("read_file"), "unknown tool lists available");
  r = await exec("read_file", { path: 12345 });
  assert(r.isError && r.content.includes("path is required"), "non-string path rejected");
  r = await exec("write_file", {});
  assert(r.isError, "missing path rejected");
  r = await exec("edit_file", { path: "edge.txt" });
  assert(r.isError, "missing oldString rejected");

  await h.shutdown();
}
