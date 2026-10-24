import { Writable, PassThrough } from "node:stream";
import { assert } from "./helpers.mjs";

/**
 * TUI component render tests — render REAL ink components with a fake stdout,
 * strip ANSI, and assert on the visible frame. Catches JSX crashes, broken
 * hooks and layout regressions without needing a TTY.
 *
 * NOTE: ink skips rendering when it detects `CI=true` or `TERM=dumb`
 * (intended for clean CI logs). These tests render into a fake stream, so we
 * neutralize both markers BEFORE ink is ever imported.
 */
delete process.env.CI;
delete process.env.TERM;

function makeStdout() {
  const s = new Writable({
    write(chunk, _enc, cb) {
      s.output += chunk.toString();
      cb();
    },
  });
  s.output = "";
  s.columns = 100;
  s.rows = 40;
  s.isTTY = true;
  return s;
}

function makeStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[=>]/g, "");
}

async function renderTo(element, ms = 80) {
  const { render } = await import("ink");
  const React = (await import("react")).default;
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  // wait until ink actually flushed a frame (CI runners can be slow to first paint)
  const t0 = Date.now();
  while (stripAnsi(stdout.output).trim().length === 0 && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, ms));
  const frame = stripAnsi(stdout.output);
  instance.unmount();
  await new Promise((r) => setTimeout(r, 20));
  return frame;
}

const el = async () => {
  const React = (await import("react")).default;
  const ui = await import("../dist/tui/components.js");
  return { React, ui };
};

export async function test() {
  const { React, ui } = await el();
  const c = (...args) => React.createElement(...args);

  /* ---- Header ---- */
  let frame = await renderTo(c(ui.Header, { provider: "openai", model: "gpt-4o-mini", tokens: 1500, busy: false, compactAt: 6000, sessionTitle: "test session title" }));
  assert(frame.includes("NOIR"), "header shows brand");
  assert(frame.includes("openai"), "header shows provider");
  assert(frame.includes("gpt-4o-mini"), "header shows model");
  assert(frame.includes("1500 tok"), "header shows tokens");
  assert(frame.includes("test session titl"), "header shows truncated session title");
  assert(frame.includes("ready"), "ready state shown");
  assert(frame.includes("▮") || frame.includes("▯"), "context bar rendered");

  frame = await renderTo(c(ui.Header, { provider: "x", model: "y", tokens: 0, busy: true, compactAt: 10, sessionTitle: "" }));
  assert(frame.includes("thinking"), "busy spinner label");
  assert(!frame.includes("ready"), "ready hidden while busy");

  frame = await renderTo(c(ui.Header, { provider: "x", model: "y", tokens: 6000, busy: false, compactAt: 6000, sessionTitle: "" }));
  assert(frame.includes("100%"), "context bar at 100%");

  /* ---- Footer ---- */
  const modes = [
    { id: "chat", label: "CHAT" },
    { id: "terminal", label: "TERM" },
  ];
  frame = await renderTo(c(ui.Footer, { modes, current: "terminal", extra: "ctrl+c=exit" }));
  assert(frame.includes("[TERM]"), "active mode bracketed");
  assert(frame.includes("CHAT"), "inactive mode plain");
  assert(frame.includes("ctrl+c=exit"), "footer extra hint");

  /* ---- PanelView ---- */
  frame = await renderTo(c(ui.PanelView, { title: "MEMORY", content: "some note text", loading: false }));
  assert(frame.includes("MEMORY"), "panel title");
  assert(frame.includes("some note text"), "panel content");

  frame = await renderTo(c(ui.PanelView, { title: "SKILLS", content: "", loading: true }));
  assert(frame.includes("SKILLS"), "loading panel renders title");

  /* ---- Composer ---- */
  frame = await renderTo(
    c(ui.Composer, { value: "hello world", onChange: () => {}, onSubmit: () => {}, onHistory: () => {}, onAbort: () => {}, busy: false, placeholder: "type here" })
  );
  assert(frame.includes("hello world"), "composer shows input value");
  assert(frame.includes("enter=send"), "composer hint");
  assert(frame.includes("»"), "chat prompt glyph");

  frame = await renderTo(
    c(ui.Composer, { value: "/help", onChange: () => {}, onSubmit: () => {}, onHistory: () => {}, onAbort: () => {}, busy: true, placeholder: "x" })
  );
  assert(frame.includes("/help"), "command input shown");
  assert(frame.includes("esc=abort"), "busy hint shown");
  assert(frame.includes("◇"), "command prompt glyph");

  frame = await renderTo(
    c(ui.Composer, { value: "!ls", onChange: () => {}, onSubmit: () => {}, onHistory: () => {}, onAbort: () => {}, busy: false, placeholder: "x" })
  );
  assert(frame.includes("◆"), "shell prompt glyph");

  frame = await renderTo(
    c(ui.Composer, { value: "", onChange: () => {}, onSubmit: () => {}, onHistory: () => {}, onAbort: () => {}, busy: false, placeholder: "PLACEHOLDER-TEXT" })
  );
  assert(frame.includes("PLACEHOLDER-TEXT"), "placeholder visible when empty");

  /* ---- LogView + item kinds ---- */
  const items = [
    ui.makeItem("user", "user message text"),
    ui.makeItem("assistant", "assistant reply text"),
    ui.makeItem("tool", "▸ write_file {…}"),
    ui.makeItem("note", "· system note"),
    ui.makeItem("cmd", "/compact output"),
    ui.makeItem("shell-out", "shell output line"),
  ];
  frame = await renderTo(c(ui.LogView, { items, streaming: null, height: 20, scroll: 0 }));
  assert(frame.includes("user message text"), "user item rendered");
  assert(frame.includes("assistant reply text"), "assistant item rendered");
  assert(frame.includes("▸ write_file"), "tool item rendered");
  assert(frame.includes("system note"), "note item rendered");
  assert(frame.includes("shell output line"), "shell item rendered");

  frame = await renderTo(c(ui.LogView, { items: [], streaming: "streaming partial…", height: 10, scroll: 0 }));
  assert(frame.includes("streaming partial…"), "streaming buffer shown");

  const many = Array.from({ length: 50 }, (_, i) => ui.makeItem("note", `note-${i}`));
  frame = await renderTo(c(ui.LogView, { items: many, streaming: null, height: 10, scroll: 0 }));
  assert(frame.includes("note-49"), "newest item visible at scroll 0");
  assert(!frame.includes("note-4\n"), "old items windowed out");

  /* ---- Wordmark ---- */
  frame = await renderTo(c(ui.Wordmark, {}));
  assert(frame.includes("███"), "wordmark block glyph");
  frame = await renderTo(c(ui.Wordmark, { compact: true }));
  assert(frame.includes("NOIR"), "compact wordmark");

  /* ---- item factory ---- */
  const a = ui.makeItem("note", "x");
  const b = ui.makeItem("note", "x");
  assert(a.id !== b.id, "unique display ids");
  assertEqKind(a, "note");
  function assertEqKind(item, kind) {
    assert(item.kind === kind, `item kind is ${kind}`);
  }
}
