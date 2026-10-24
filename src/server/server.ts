import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, extname, normalize, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { Harness } from "../core/harness.js";
import { NOIR_VERSION } from "../core/harness.js";
import { PROVIDER_PRESETS } from "../core/providers/index.js";
import { listWebApps, webAppRoot, webAppDataRoot, safeAppFile } from "../core/webapps.js";

export interface ServerHandle {
  httpServer: Server;
  url: string;
  port: number;
  host: string;
  token: string | null;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const __webdir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** SSE writer helper. */
function openSse(res: ServerResponse): { send(event: unknown): void; close(): void } {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.flushHeaders?.();
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  return {
    send(event: unknown): void {
      if (closed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close(): void {
      if (!closed && !res.writableEnded) res.end();
    },
  };
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-noir-token");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
  }
}

export async function startServer(
  harness: Harness,
  opts: { host?: string; port?: number } = {}
): Promise<ServerHandle> {
  const host = opts.host ?? harness.config.server.host ?? "127.0.0.1";
  const port = opts.port ?? harness.config.server.port ?? 5178;
  const needsToken = host !== undefined && !isLoopback(host) && harness.config.server.auth !== false;
  const token = needsToken ? harness.config.server.token || randomBytes(16).toString("hex") : null;

  const httpServer = createServer(async (req, res) => {
    try {
      cors(req, res);
      if (req.method === "OPTIONS") return;

      const url = new URL(req.url ?? "/", "http://local");
      const rawPath = decodeURIComponent(url.pathname);

      if (process.env.NOIR_DEBUG_ROUTES === "1") {
        console.log(`[route] req.url=${JSON.stringify(req.url)} -> rawPath=${JSON.stringify(rawPath)}`);
      }

      // defense in depth: reject dot-segment traversal on ANY route, before
      // path.normalize() has a chance to silently collapse it
      if (rawPath.split("/").includes("..")) {
        sendJson(res, 400, { error: "path traversal rejected" });
        return;
      }

      const path = normalize(rawPath).replace(/\\/g, "/");

      // auth check
      if (token) {
        const provided = req.headers["x-noir-token"] ?? url.searchParams.get("token");
        if (provided !== token) {
          sendJson(res, 401, { error: "unauthorized — pass x-noir-token header" });
          return;
        }
      }

      if (req.method === "GET" || req.method === "HEAD") {
        await handleGet(harness, path, req, res);
        return;
      }
      if (req.method === "POST") {
        await handlePost(harness, path, req, res);
        return;
      }
      if (req.method === "DELETE") {
        await handleDelete(harness, path, req, res);
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
    } catch (err) {
      try {
        sendJson(res, 500, { error: (err as Error).message });
      } catch {
        /* socket gone */
      }
    }
  });

  await new Promise<void>((resolvePromise) => httpServer.listen(port, host, resolvePromise));
  const addr = httpServer.address();
  const realPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    httpServer,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${realPort}`,
    port: realPort,
    host,
    token,
    close(): Promise<void> {
      return new Promise((resolvePromise, rejectPromise) => {
        httpServer.close((err) => (err ? rejectPromise(err) : resolvePromise()));
      });
    },
  };
}

/** ------------------------------------------------------------ GET ---- */

async function handleGet(harness: Harness, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // API
  if (path === "/api/state") {
    sendJson(res, 200, {
      version: NOIR_VERSION,
      provider: harness.config.provider,
      model: harness.model,
      providerReady: Boolean(harness.provider),
      providerError: harness.providerError,
      projectDir: harness.projectDir,
      session: { id: harness.session.id, title: harness.session.title, messages: harness.session.messages.length, tokens: harness.session.estimateTokens() },
      taskBoard: harness.session.taskBoard,
      tools: harness.tools.names(),
      skills: harness.skills.list().map((s) => ({ id: s.id, description: s.description, source: s.source })),
      agents: harness.subagents.listTypes().map((a) => ({ name: a.name, description: a.description, source: a.source })),
      panels: [...harness.panels.values()].map((p) => ({ id: p.id, title: p.title })),
      webapps: listWebApps(harness.projectDir),
      commands: [...harness.commands.values()].map((c) => ({ name: c.name, description: c.description })),
      mcp: harness.mcp.listServers(),
      memory: { notes: harness.memory.readNotes(), facts: harness.memory.readFacts(), snapshots: harness.memory.listSnapshots() },
      search: harness.config.search.provider,
      busy: harness.isBusy(),
      presets: Object.fromEntries(
        Object.entries(PROVIDER_PRESETS).map(([id, p]) => [id, { label: p.label, models: p.models, needsKey: p.needsKey }])
      ),
    });
    return;
  }

  if (path === "/api/sessions") {
    sendJson(res, 200, harness.listSessions());
    return;
  }

  if (path === "/api/config") {
    const masked = JSON.parse(JSON.stringify(harness.config)) as Record<string, any>;
    if (masked.apiKey) masked.apiKey = "***";
    for (const k of Object.keys(masked.providers ?? {})) {
      if (masked.providers[k]?.apiKey) masked.providers[k].apiKey = "***";
    }
    if (masked.search?.braveKey) masked.search.braveKey = "***";
    if (masked.search?.tavilyKey) masked.search.tavilyKey = "***";
    if (masked.server?.token) masked.server.token = "***";
    sendJson(res, 200, masked);
    return;
  }

  if (path === "/api/memory") {
    sendJson(res, 200, {
      notes: harness.memory.readNotes(),
      facts: harness.memory.readFacts(),
      global: harness.memory.readGlobalNotes(),
      snapshots: harness.memory.listSnapshots(),
    });
    return;
  }

  // panel content (extensions)
  const panelMatch = path.match(/^\/api\/panel\/([\w.-]+)$/);
  if (panelMatch) {
    const panel = harness.panels.get(panelMatch[1]);
    if (!panel) {
      sendJson(res, 404, { error: `panel "${panelMatch[1]}" not found` });
      return;
    }
    sendJson(res, 200, { id: panel.id, title: panel.title, content: await panel.render(harness) });
    return;
  }

  // web-app data API (read/list) — /api/app-data/<name>?file=... | ?list=1
  const appDataGet = path.match(/^\/api\/app-data\/([a-z0-9-]+)$/i);
  if (appDataGet) {
    const reqUrl = new URL(req.url ?? "/", "http://local");
    const dataRoot = webAppDataRoot(harness.projectDir, appDataGet[1]);
    if (!dataRoot) {
      sendJson(res, 400, { error: "invalid app name" });
      return;
    }
    try {
      if (reqUrl.searchParams.get("list") === "1") {
        const out: Array<{ file: string; size: number; updated: string }> = [];
        const walkData = (dir: string) => {
          if (!existsSync(dir)) return;
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, f.name);
            if (f.isDirectory()) walkData(full);
            else {
              const st = statSync(full);
              out.push({ file: relative(dataRoot, full).split("\\").join("/"), size: st.size, updated: st.mtime.toISOString() });
            }
          }
        };
        mkdirSync(dataRoot, { recursive: true });
        walkData(dataRoot);
        sendJson(res, 200, { files: out.sort((a, b) => b.updated.localeCompare(a.updated)) });
        return;
      }
      const file = reqUrl.searchParams.get("file") ?? "";
      const full = safeAppFile(dataRoot, file);
      if (!existsSync(full) || !statSync(full).isFile()) {
        sendJson(res, 404, { error: `file not found: ${file}` });
        return;
      }
      const st = statSync(full);
      if (st.size > 512 * 1024) {
        sendJson(res, 413, { error: "file too large for app-data reads (512KB cap)" });
        return;
      }
      sendJson(res, 200, { file, content: readFileSync(full, "utf8"), updated: st.mtime.toISOString() });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // project web apps — /apps/<name>/...
  if (path === "/apps" || path.startsWith("/apps/")) {
    const name = path.slice(6).split("/")[0] ?? "";
    const root = webAppRoot(harness.projectDir, name);
    if (!root || !existsSync(root)) {
      sendJson(res, 404, { error: `web app "${name}" is not installed (expected .noir/webapps/${name}/)` });
      return;
    }
    let rel = path.slice(6 + name.length) || "/";
    if (rel.endsWith("/")) rel += "index.html";
    const full = resolve(join(root, rel.replace(/^\/+/, "")));
    const relCheck = relative(root, full);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
      sendJson(res, 400, { error: "invalid app path" });
      return;
    }
    let target = full;
    if (!existsSync(target) || statSync(target).isDirectory()) {
      target = join(target, "index.html");
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      sendJson(res, 404, { error: "not found in web app" });
      return;
    }
    const mime = MIME[extname(target)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store", "x-frame-options": "SAMEORIGIN" });
    res.end(readFileSync(target));
    return;
  }

  // static files (the PWA)
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(path, res);
    return;
  }
}

function serveStatic(path: string, res: ServerResponse): void {
  let rel = path === "/" ? "/index.html" : path;
  if (rel.startsWith("/api/") || rel.startsWith("/apps/")) {
    // /apps/* has its own handler; never let the SPA fallback swallow it
    sendJson(res, 404, { error: "not found" });
    return;
  }
  rel = rel.replace(/^\/+/, "");
  const full = join(__webdir, rel);
  if (!full.startsWith(__webdir) || !existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback
    const index = join(__webdir, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(index));
      return;
    }
    sendJson(res, 404, { error: "not found (web assets missing — run `npm run build`)" });
    return;
  }
  const mime = MIME[extname(full)] ?? "application/octet-stream";
  const cache = rel.startsWith("icons/") ? "public, max-age=86400" : "no-store";
  res.writeHead(200, { "content-type": mime, "cache-control": cache });
  res.end(readFileSync(full));
}

/** ------------------------------------------------------------ POST --- */

async function handlePost(harness: Harness, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = ["application/json", ""].includes(String(req.headers["content-type"] ?? "").split(";")[0])
    ? JSON.parse((await readBody(req)).toString("utf8") || "{}")
    : {};

  if (path === "/api/chat") {
    const text = String(body.text ?? "").trim();
    if (!text) {
      sendJson(res, 400, { error: "text required" });
      return;
    }
    const sse = openSse(res);
    try {
      for await (const ev of harness.chat(text)) {
        sse.send(ev);
      }
    } catch (err) {
      sse.send({ type: "note", text: `error: ${(err as Error).message}` });
    }
    sse.send({ type: "done", reason: "end" });
    sse.close();
    return;
  }

  if (path === "/api/abort") {
    harness.abort();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/api/compact") {
    const r = await harness.compact();
    sendJson(res, 200, r);
    return;
  }

  if (path === "/api/terminal") {
    const command = String(body.command ?? "");
    if (!command.trim()) {
      sendJson(res, 400, { error: "command required" });
      return;
    }
    const sse = openSse(res);
    const r = await harness.runShell(command, (chunk) => sse.send({ type: "out", v: chunk }), Number(body.timeoutMs ?? 0) || undefined);
    sse.send({ type: "exit", code: r.exitCode, timedOut: r.timedOut });
    sse.close();
    return;
  }

  if (path === "/api/command") {
    const name = String(body.name ?? "").replace(/^\//, "");
    const args = Array.isArray(body.args) ? body.args.map(String) : String(body.args ?? "").split(/\s+/).filter(Boolean);
    const cmd = harness.commands.get(name);
    if (!cmd) {
      sendJson(res, 404, { error: `unknown command /${name}` });
      return;
    }
    const out = await cmd.run(args, harness);
    sendJson(res, 200, { ok: true, output: String(out) });
    return;
  }

  if (path === "/api/session") {
    const action = String(body.action ?? "");
    if (action === "new") {
      harness.newSession();
    } else if (action === "resume") {
      const s = harness.resumeSession(String(body.id ?? ""));
      if (!s) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
    } else {
      sendJson(res, 400, { error: "action must be new|resume" });
      return;
    }
    sendJson(res, 200, { ok: true, session: { id: harness.session.id, title: harness.session.title, messages: harness.session.messages.length } });
    return;
  }

  if (path === "/api/subagent") {
    const type = String(body.agent ?? "general");
    const task = String(body.task ?? "").trim();
    if (!task) {
      sendJson(res, 400, { error: "task required" });
      return;
    }
    const sse = openSse(res);
    sse.send({ type: "start", text: `subagent ${type} running…` });
    const r = await harness.subagents.run(type, task, { timeoutMs: 600000 });
    sse.send({ type: "result", text: r.result, error: r.error });
    sse.close();
    return;
  }

  if (path === "/api/swarm") {
    const objective = String(body.objective ?? "").trim();
    if (!objective) {
      sendJson(res, 400, { error: "objective required" });
      return;
    }
    const sse = openSse(res);
    const onSwarm = (p: { phase: string; detail?: string }) => sse.send({ type: "swarm", phase: p.phase, detail: p.detail });
    harness.events.sub("swarm", onSwarm);
    try {
      const report = await harness.swarm.run(objective, { workers: Number(body.workers ?? 4) });
      sse.send({ type: "result", text: report });
    } catch (err) {
      sse.send({ type: "error", text: (err as Error).message });
    } finally {
      harness.events.unsub("swarm", onSwarm);
    }
    sse.close();
    return;
  }

  // web-app data API (write) — POST /api/app-data/<name> {file, content}
  const appDataPost = path.match(/^\/api\/app-data\/([a-z0-9-]+)$/i);
  if (appDataPost) {
    const dataRoot = webAppDataRoot(harness.projectDir, appDataPost[1]);
    if (!dataRoot) {
      sendJson(res, 400, { error: "invalid app name" });
      return;
    }
    try {
      const file = String(body.file ?? "");
      const content = String(body.content ?? "");
      if (content.length > 512 * 1024) {
        sendJson(res, 413, { error: "content too large (512KB cap per file)" });
        return;
      }
      const full = safeAppFile(dataRoot, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      sendJson(res, 200, { ok: true, file, bytes: content.length });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (path === "/api/config") {
    // whitelist patchable keys
    const allowed: Array<string[]> = [
      ["provider"], ["model"], ["temperature"], ["compactAtTokens"], ["maxSteps"], ["baseUrl"],
      ["search", "provider"], ["search", "braveKey"], ["search", "tavilyKey"], ["search", "searxUrl"],
      ["server", "host"], ["server", "port"], ["providers"],
    ];
    const patch = body as Record<string, unknown>;
    let applied = 0;
    for (const [root, key] of allowed.map((a) => [a[0], a[1]])) {
      if (patch[root] === undefined) continue;
      if (key) {
        const v = (patch[root] as Record<string, unknown>)[key];
        if (v === undefined) continue;
        (harness.config as unknown as Record<string, Record<string, unknown>>)[root][key] = v;
        applied++;
      } else {
        (harness.config as unknown as Record<string, unknown>)[root] = patch[root];
        applied++;
      }
    }
    if (patch.apiKey) {
      harness.config.apiKey = String(patch.apiKey);
      applied++;
    }
    if (typeof patch.model === "string" && patch.model) {
      harness.setModel(String(patch.model)); // sync the live model, not just config
    }
    const target = body.target === "global" ? "global" : "project";
    const saved = harness.saveConfig(target);
    // re-init provider with new config
    const { createProvider } = await import("../core/providers/index.js");
    try {
      harness.provider = createProvider(harness.config.provider, harness.config);
      harness.providerError = null;
    } catch (err) {
      harness.providerError = (err as Error).message;
    }
    sendJson(res, 200, { ok: true, applied, saved });
    return;
  }

  sendJson(res, 404, { error: `unknown endpoint ${path}` });
}

/** ------------------------------------------------------------ DELETE */

async function handleDelete(harness: Harness, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");

  // web-app data API (delete) — DELETE /api/app-data/<name>?file=...
  const appDataDel = path.match(/^\/api\/app-data\/([a-z0-9-]+)$/i);
  if (appDataDel) {
    const dataRoot = webAppDataRoot(harness.projectDir, appDataDel[1]);
    if (!dataRoot) {
      sendJson(res, 400, { error: "invalid app name" });
      return;
    }
    try {
      const file = url.searchParams.get("file") ?? "";
      const full = safeAppFile(dataRoot, file);
      if (!existsSync(full)) {
        sendJson(res, 404, { error: `file not found: ${file}` });
        return;
      }
      rmSync(full);
      sendJson(res, 200, { ok: true, file });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  sendJson(res, 404, { error: `unknown endpoint ${path}` });
}
