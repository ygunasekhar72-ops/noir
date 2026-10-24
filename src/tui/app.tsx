import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, render, useApp, useInput } from "ink";
import type { Harness } from "../core/harness.js";
import { NOIR_VERSION, type PanelDef } from "../core/harness.js";
import {
  Composer,
  DisplayItem,
  Footer,
  Header,
  LogView,
  PanelView,
  makeItem,
} from "./components.js";

interface ModeDef {
  id: string;
  label: string;
}

const BASE_MODES: ModeDef[] = [
  { id: "chat", label: "CHAT" },
  { id: "terminal", label: "TERMINAL" },
  { id: "memory", label: "MEMORY" },
  { id: "skills", label: "SKILLS" },
  { id: "agents", label: "AGENTS" },
];

const panelContentLoadedAt: Record<string, number> = {};

const TuiApp: React.FC<{ harness: Harness; serverUrlRef: { current: string | null } }> = ({ harness, serverUrlRef }) => {
  const { exit } = useApp();
  const [mode, setMode] = useState("chat");
  const [items, setItems] = useState<DisplayItem[]>([
    makeItem("note", `NOIR ${NOIR_VERSION} — monochrome agent harness · project: ${harness.projectDir}`),
    makeItem(
      "note",
      harness.provider ? `provider ${harness.config.provider}/${harness.model} ready` : `⚠ no provider: ${harness.providerError}`
    ),
    makeItem("note", "type a task · /help for commands · !command for shell · tab switches panels"),
  ]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [panelContent, setPanelContent] = useState<Record<string, string>>({});
  const [panelLoading, setPanelLoading] = useState(false);
  const [exitArm, setExitArm] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const modes: ModeDef[] = useMemo(() => {
    const extra: ModeDef[] = [...harness.panels.values()].map((p: PanelDef) => ({
      id: `panel:${p.id}`,
      label: p.title.toUpperCase().slice(0, 10),
    }));
    return [...BASE_MODES, ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const push = useCallback((item: DisplayItem) => {
    setItems((prev) => (prev.length > 400 ? [...prev.slice(-380), item] : [...prev, item]));
  }, []);

  const loadStatic = useCallback(
    async (id: string) => {
      if (panelContent[id] && Date.now() - (panelContentLoadedAt[id] ?? 0) < 5000) return;
      let content = "";
      if (id === "memory") {
        const notes = harness.memory.readNotes();
        const facts = harness.memory.readFacts();
        const snaps = harness.memory.listSnapshots();
        content = `— notes.md —\n${notes || "(empty)"}\n\n— facts.md —\n${facts || "(empty)"}\n\n— snapshots (${snaps.length}) —\n${snaps
          .slice(0, 8)
          .map((s) => s.file)
          .join("\n")}`;
      } else if (id === "skills") {
        const all = harness.skills.list();
        content = all.length
          ? all.map((s) => `${s.id} [${s.source}]\n  ${s.description}`).join("\n")
          : "no skills installed — add .noir/skills/<name>/SKILL.md";
      } else if (id === "agents") {
        const defs = harness.subagents.listTypes();
        content =
          `subagent types:\n${defs.map((d) => `  ${d.name} — ${d.description}`).join("\n")}\n\n` +
          `usage: /agent <type> <task>\nswarm: /swarm <objective>\nsessions: /sessions · /resume <id>` +
          (serverUrl ? `\napp server: ${serverUrl}` : "\napp server: run /serve");
      } else if (id === "terminal") {
        content = panelContent["terminal"] ?? "Built-in terminal. Type a command and press enter.";
      }
      panelContentLoadedAt[id] = Date.now();
      setPanelContent((prev) => ({ ...prev, [id]: content }));
    },
    [harness, panelContent, serverUrl]
  );

  const loadPanel = useCallback(
    async (id: string) => {
      const panel = harness.panels.get(id);
      if (!panel) return;
      setPanelLoading(true);
      try {
        const content = await panel.render(harness);
        setPanelContent((prev) => ({ ...prev, [id]: String(content) }));
      } catch (err) {
        setPanelContent((prev) => ({ ...prev, [id]: `panel error: ${(err as Error).message}` }));
      } finally {
        setPanelLoading(false);
      }
    },
    [harness]
  );

  useEffect(() => {
    const sub = (payload: { message: string }) => push(makeItem("note", `· ${payload.message}`));
    harness.events.sub("log", sub);
    return () => harness.events.unsub("log", sub);
  }, [harness, push]);

  const cycleMode = useCallback(
    (dir: number) => {
      setMode((cur) => {
        const all = [...BASE_MODES, ...[...harness.panels.values()].map((p: PanelDef) => ({ id: `panel:${p.id}`, label: p.title }))];
        const curIdx = all.findIndex((m) => m.id === cur);
        const next = all[(curIdx + dir + all.length) % all.length];
        if (next.id.startsWith("panel:")) void loadPanel(next.id.slice(6));
        else if (next.id === "terminal") void loadStatic("terminal");
        else if (next.id !== "chat") void loadStatic(next.id);
        return next.id;
      });
    },
    [harness.panels, loadPanel, loadStatic]
  );

  /** ------------------------------------------------------------------ submit */
  const handleSubmit = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      setInput("");
      if (!value) return;
      historyRef.current.push(value);
      if (historyRef.current.length > 100) historyRef.current.shift();
      histIdxRef.current = -1;

      // ---- terminal panel: raw shell
      if (mode === "terminal" && !value.startsWith("/")) {
        setPanelContent((prev) => ({ ...prev, terminal: (prev.terminal ?? "") + `\n$ ${value}\n` }));
        setBusy(true);
        try {
          const r = await harness.runShell(value, () => {}, 600000);
          const out = r.output || "(no output)";
          setPanelContent((prev) => ({ ...prev, terminal: (prev.terminal ?? "") + out + `\n[exit ${r.exitCode}]\n` }));
          panelContentLoadedAt["terminal"] = Date.now();
        } catch (err) {
          setPanelContent((prev) => ({ ...prev, terminal: (prev.terminal ?? "") + `error: ${(err as Error).message}\n` }));
        } finally {
          setBusy(false);
        }
        return;
      }

      // ---- shell passthrough (chat mode)
      if (value.startsWith("!")) {
        const cmd = value.slice(1);
        push(makeItem("user", `!${cmd}`));
        setBusy(true);
        try {
          const r = await harness.runShell(cmd, () => {}, 600000);
          push(makeItem("shell-out", r.output || "(no output)"));
          push(makeItem("note", `[exit ${r.exitCode}]`));
        } catch (err) {
          push(makeItem("note", `shell error: ${(err as Error).message}`));
        } finally {
          setBusy(false);
        }
        return;
      }

      // ---- commands
      if (value.startsWith("/")) {
        const parts = value.slice(1).split(/\s+/);
        const name = parts[0];
        const args = parts.slice(1);
        push(makeItem("cmd", value));
        if (name === "exit" || name === "quit") {
          push(makeItem("note", "shutting down…"));
          await gracefulExit();
          return;
        }
        if (name === "serve") {
          if (serverUrlRef.current) {
            push(makeItem("note", `already serving at ${serverUrlRef.current}`));
            return;
          }
          const { startServer } = await import("../server/server.js");
          const handle = await startServer(harness, { host: harness.config.server.host, port: harness.config.server.port });
          serverUrlRef.current = handle.url;
          setServerUrl(`${handle.url}${handle.token ? `?token=${handle.token}` : ""}`);
          push(
            makeItem(
              "note",
              `mobile app serving at ${handle.url}${handle.token ? ` (token ${handle.token})` : ""} — open on your phone → Add to Home screen`
            )
          );
          return;
        }
        const cmd = harness.commands.get(name);
        if (!cmd) {
          push(makeItem("note", `unknown command /${name} — /help`));
          return;
        }
        setBusy(true);
        try {
          const out = await cmd.run(args, harness);
          push(makeItem("cmd", String(out)));
        } catch (err) {
          push(makeItem("note", `command error: ${(err as Error).message}`));
        } finally {
          setBusy(false);
          setTokens(harness.session.estimateTokens());
        }
        return;
      }

      // ---- chat
      push(makeItem("user", value));
      setBusy(true);
      setStreaming("");
      try {
        for await (const ev of harness.chat(value)) {
          if (ev.type === "delta") {
            setStreaming((s) => (s ?? "") + ev.text);
          } else if (ev.type === "message" && ev.message.role === "assistant") {
            if (ev.message.content) push(makeItem("assistant", ev.message.content));
            setStreaming(null);
          } else if (ev.type === "tool" && ev.phase === "start") {
            const argsSum = JSON.stringify(ev.args ?? {});
            push(makeItem("tool", `▸ ${ev.name} ${argsSum.length > 90 ? argsSum.slice(0, 90) + "…" : argsSum}`));
          } else if (ev.type === "tool" && ev.phase === "end") {
            const preview = (ev.result ?? "").split("\n").slice(0, 4).join(" ⏎ ").slice(0, 220);
            push(makeItem("tool", ev.ok ? `  ↳ ${preview}` : `  ↳ ERROR: ${preview}`));
          } else if (ev.type === "compaction") {
            push(makeItem("note", `· compaction ${ev.phase}${ev.detail ? ` — ${ev.detail}` : ""}`));
          } else if (ev.type === "note") {
            push(makeItem("note", ev.text));
          } else if (ev.type === "done") {
            if (ev.reason === "aborted") push(makeItem("note", "· aborted"));
            setStreaming(null);
          }
        }
      } catch (err) {
        push(makeItem("note", `error: ${(err as Error).message}`));
      } finally {
        setStreaming(null);
        setBusy(false);
        setTokens(harness.session.estimateTokens());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, harness, push, serverUrlRef]
  );

  const gracefulExit = useCallback(async () => {
    await harness.shutdown();
    exit();
    setTimeout(() => process.exit(0), 80);
  }, [harness, exit]);

  /** ------------------------------------------------------------------ global keys */
  useInput((_input, key) => {
    if (key.tab) {
      cycleMode(key.shift ? -1 : 1);
      return;
    }
    if (key.escape && busy) {
      harness.abort();
      return;
    }
    if (key.ctrl && _input === "u") {
      setScroll((s) => Math.min(s + 1, 40));
      return;
    }
    if (key.ctrl && _input === "d") {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.ctrl && _input === "l") {
      setItems([]);
      setScroll(0);
      return;
    }
  });

  // ctrl+c: 1st press aborts a running turn, 2nd press exits
  useEffect(() => {
    const handler = (data: Buffer | string) => {
      if (String(data) !== "\x03") return;
      if (busy) {
        harness.abort();
        push(makeItem("note", "· aborting generation…"));
        return;
      }
      if (exitArm) {
        void gracefulExit();
      } else {
        setExitArm(true);
        push(makeItem("note", "· press ctrl+c again to exit"));
        if (exitTimer.current) clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => setExitArm(false), 2500);
      }
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, [busy, exitArm, gracefulExit, harness, push]);

  const historyNav = useCallback((delta: number) => {
    const hist = historyRef.current;
    if (!hist.length) return;
    let i = histIdxRef.current === -1 ? hist.length : histIdxRef.current;
    i = Math.max(0, Math.min(hist.length, i + delta));
    histIdxRef.current = i;
    setInput(i === hist.length ? "" : hist[i]);
  }, []);

  const footerExtra = busy ? "esc=abort" : "ctrl+c=exit";

  return (
    <Box flexDirection="column" height="100%">
      <Header
        provider={harness.config.provider}
        model={harness.model}
        tokens={tokens}
        busy={busy}
        compactAt={harness.config.compactAtTokens}
        sessionTitle={harness.session.title}
      />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {mode === "chat" ? (
          <LogView items={items} streaming={streaming} height={Math.max(6, (process.stdout.rows ?? 40) - 12)} scroll={scroll} />
        ) : mode.startsWith("panel:") ? (
          <PanelView
            title={harness.panels.get(mode.slice(6))?.title ?? mode}
            content={panelContent[mode.slice(6)] ?? "loading…"}
            loading={panelLoading}
          />
        ) : (
          <PanelView
            title={mode === "terminal" ? "TERMINAL — commands run in the project dir" : mode.toUpperCase()}
            content={panelContent[mode] ?? "loading…"}
            loading={panelLoading}
          />
        )}
      </Box>
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onHistory={historyNav}
        onAbort={() => harness.abort()}
        busy={busy}
        placeholder={mode === "terminal" ? "shell command…" : "task, /command or !shell"}
      />
      <Footer modes={modes} current={mode} extra={footerExtra} />
    </Box>
  );
};

export async function renderTui(harness: Harness): Promise<void> {
  const serverUrlRef = { current: null as string | null };
  const instance = render(<TuiApp harness={harness} serverUrlRef={serverUrlRef} />, {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
  await harness.shutdown();
}
