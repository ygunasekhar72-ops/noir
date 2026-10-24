import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq } from "./helpers.mjs";

/**
 * Web-app <-> server contract: every endpoint the mobile app calls must exist
 * on the server, every static asset referenced must exist, and the PWA
 * manifest must be install-grade. Catches drift between src/web and src/server.
 */
export async function test() {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcWeb = join(here, "..", "src", "web");
  const serverSrc = readFileSync(join(here, "..", "src", "server", "server.ts"), "utf8");

  /* ---- 1. static assets referenced by index.html all exist ---- */
  const html = readFileSync(join(srcWeb, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (ref.startsWith("icons/")) {
      assert(existsSync(join(srcWeb, ref)), `referenced icon exists: ${ref}`);
    } else if (!ref.startsWith("http")) {
      assert(existsSync(join(srcWeb, ref)), `referenced asset exists: ${ref}`);
    }
  }
  assert(html.includes("viewport-fit=cover"), "mobile safe-area viewport");
  assert(html.includes("theme-color"), "theme color meta");
  assert(html.includes('rel="manifest"'), "manifest linked");
  assert(html.includes("apple-mobile-web-app-capable"), "iOS standalone meta");

  /* ---- 2. manifest install-grade ---- */
  const manifest = JSON.parse(readFileSync(join(srcWeb, "manifest.webmanifest"), "utf8"));
  assertEq(manifest.display, "standalone", "manifest display standalone");
  assert(manifest.name && manifest.short_name, "manifest names");
  assertEq(manifest.background_color, "#000000", "monochrome background");
  assertEq(manifest.theme_color, "#000000", "monochrome theme");
  assert(manifest.start_url === "/", "start_url");
  const icons = manifest.icons ?? [];
  assert(icons.some((i) => i.sizes === "192x192"), "192 icon declared");
  assert(icons.some((i) => i.sizes === "512x512"), "512 icon declared");
  assert(icons.every((i) => i.purpose.includes("maskable")), "maskable icons");
  for (const i of icons) {
    const p = join(srcWeb, i.src.replace(/^\//, ""));
    assert(existsSync(p), `manifest icon file exists: ${i.src}`);
    const buf = readFileSync(p);
    assertEq(buf.readUInt32BE(0), 0x89504e47, `valid PNG signature: ${i.src}`);
  }

  /* ---- 3. service worker cache list matches real files ---- */
  const sw = readFileSync(join(srcWeb, "sw.js"), "utf8");
  const cacheList = sw.match(/const SHELL = \[([\s\S]*?)\]/)?.[1] ?? "";
  const cached = [...cacheList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const c of cached) {
    if (c === "/") continue;
    assert(existsSync(join(srcWeb, c.replace(/^\//, ""))), `SW cache entry exists: ${c}`);
  }
  assert(sw.includes('pathname.startsWith("/api/")'), "SW passes API through to network");
  assert(!sw.includes("caches.match(e.request) && false"), "SW fetch handler sane");

  /* ---- 4. every API call in app.js exists on the server ---- */
  const app = readFileSync(join(srcWeb, "app.js"), "utf8");
  const appEndpoints = new Set(
    [...app.matchAll(/["'`](\/api\/[a-z0-9/_-]*)["'`]/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ":param"))
  );
  const serverEndpoints = new Set([...serverSrc.matchAll(/path === "(\/api\/[a-z0-9/_-]*)"/g)].map((m) => m[1]));
  const panelCall = [...app.matchAll(/\/api\/panel\//g)].length;
  for (const ep of appEndpoints) {
    assert(serverEndpoints.has(ep), `app calls "${ep}" — must exist in server.ts`);
  }
  assert(panelCall >= 1, "panel loading call present in app.js");

  /* ---- 5. server route sanity: no orphan core endpoints the app never surfaces ---- */
  const coreRoutes = ["/api/state", "/api/chat", "/api/abort", "/api/terminal", "/api/command", "/api/session", "/api/sessions", "/api/config", "/api/compact", "/api/memory", "/api/subagent", "/api/swarm"];
  for (const route of coreRoutes) {
    assert(serverEndpoints.has(route), `core route ${route} implemented`);
  }

  /* ---- 6. app.js is syntactically valid (node --check equivalent) ---- */
  await import(join(srcWeb, "sw.js")).catch(() => undefined); // sw.js runs only under import guard
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, ["--check", join(srcWeb, "app.js")], { stdio: "pipe" });
    assert(true, "app.js syntax valid");
  } catch (err) {
    assert(false, `app.js syntax error: ${err.message}`);
  }
  try {
    execFileSync(process.execPath, ["--check", join(srcWeb, "sw.js")], { stdio: "pipe" });
    assert(true, "sw.js syntax valid");
  } catch (err) {
    assert(false, `sw.js syntax error: ${err.message}`);
  }

  /* ---- 7. styles: strict monochrome guard (no saturated colors) ---- */
  const css = readFileSync(join(srcWeb, "styles.css"), "utf8");
  const colorDecls = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set(["#000000", "#fff", "#000", "#0a0a0a", "#111111", "#2a2a2a", "#1a1a1a", "#f2f2f2", "#8f8f8f", "#5c5c5c", "#ffffff"]);
  const offenders = colorDecls.filter((c) => !allowed.has(c));
  assertEq(offenders.length, 0, `strict monochrome palette — offenders: ${offenders.join(", ")}`);
  assert(!/rgb\((?!.*(,)\s*\1\s*,\s*\1)/.test(css), "no rgb() colors");
  assert(!/hsl\(/.test(css), "no hsl() colors");
}
