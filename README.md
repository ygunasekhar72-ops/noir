```
███╗   ██╗ ██████╗ ██╗██████╗
████╗  ██║██╔═══██╗██║██╔══██╗
██╔██╗ ██║██║   ██║██║██║  ██║
██║╚██╗██║██║   ██║██║██║  ██║
██║ ╚████║╚██████╔╝██║██████╔╝
╚═╝  ╚═══╝ ╚═════╝ ╚═╝╚═════╝
```

# NOIR — the monochrome agent harness for terminal & mobile

[![CI](https://github.com/ygunasekhar72-ops/noir/actions/workflows/ci.yml/badge.svg)](https://github.com/ygunasekhar72-ops/noir/actions/workflows/ci.yml)

NOIR is a **coding/agent harness in the spirit of OpenCode and Claude Code**, built to run equally well in your **terminal** and on your **Android phone** — with a strict **black & white UI**, and a **memory workspace that is saved before compaction** so long projects never lose context.

It runs on plain **Node.js ≥ 18** — no native modules — so it installs and runs natively in **Termux** on Android, and on any desktop.

---

## Feature matrix

| Requirement | Where |
|---|---|
| **Plugin system** | `.noir/plugins/*/plugin.js` + `~/.noir/plugins/` — register tools, commands, hooks (see `plugins/examples/`) |
| **MCP system** | Full JSON-RPC MCP client, stdio + HTTP transports. Server tools become first-class agent tools (`mcp__server__tool`) |
| **Built-in terminal** | `run_command` tool, TUI TERMINAL panel, `!command` passthrough, mobile TERMINAL tab |
| **Skills** | `SKILL.md` packs with YAML frontmatter (project / global / built-in) — see `skills/` |
| **AI system (API keys)** | OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together, xAI, Ollama, LM Studio, any OpenAI-compatible endpoint |
| **Extensions (mobile)** | `.noir/extensions/*.js` contribute **panels** (TUI tabs + mobile app tabs) and commands — plain-text rendering, guaranteed on mobile |
| **Web search** | DuckDuckGo (keyless) by default; Brave, Tavily, SearxNG with keys; plus `web_fetch` |
| **Subagents** | `spawn_subagent` — explore / coder / researcher / writer / general + custom roles via `.noir/agents/*.json` |
| **Multi-agent system** | `swarm` — planner → parallel worker pool → synthesizer, board persisted in `.noir/swarm/` |
| **Memory before compaction** | `<project>/.noir/memory/` — notes.md, facts.md, **full transcript snapshots written before every compaction**, distilled summaries, subagent transcripts |
| **Required tools** | read/write/edit, glob, grep, shell, web search/fetch, memory, task board, skills, subagents, swarm, MCP — 18 built-in |
| **Android support** | Termux TUI + installable PWA app (Add to Home Screen) |
| **Black & white UI** | Monochrome TUI (Ink) + monochrome mobile app. Zero color. Zero clutter. |
| **Terminal + APP** | `noir` (TUI) and `noir serve` (mobile app on your phone) |

---

## Install

### Android (Termux) — the full experience

```bash
pkg update && pkg install nodejs-lts git -y
git clone <this-repo> ~/noir
cd ~/noir
npm install
npm run build
npm link        # makes the `noir` command available everywhere
```

Then in any project:

```bash
cd ~/myproject
noir            # terminal UI
noir serve      # start the mobile app — open http://127.0.0.1:5178 in Chrome
                 # menu → "Add to Home screen" → NOIR installs as a real app
```

Tip: run `termux-wake-lock` before long swarm jobs so Android doesn't sleep the process.

### Desktop (Windows / macOS / Linux)

```bash
npm install && npm run build
node bin/noir.js           # TUI
node bin/noir.js serve     # app in your browser
```

## Quick start

```bash
export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY / GEMINI_API_KEY / GROQ_API_KEY ...
cd myproject
noir                                # TUI: type a task, press enter
```

```
NOIR ▪ openai/gpt-4o-mini
❯ refactor src/api.ts to use async/await
◆ Reading the file…
▸ read_file {"path":"src/api.ts"}
  ↳ 42| function getUser(id) {
▸ edit_file {"path":"src/api.ts", …}
  ↳ OK — replaced 1 occurrence(s)
◆ Done — 3 callbacks converted to async functions.
```

### One-shot & headless

```bash
noir run "fix the failing tests in this repo"     # agent turn, non-interactive
noir run --json "summarize the architecture"       # JSONL event stream
noir agent explore "where is auth handled?"        # single subagent
noir swarm "build a landing page from scratch"     # multi-agent swarm
noir chat                                        # plain REPL
```

### Key CLI surface

```
noir                    # TUI (default)
noir serve [--host H] [--port P] [--open]
noir run | chat | agent | swarm
noir sessions | skills | plugins | extensions | mcp | tools | memory | models
noir doctor | init | version | help
```

Flags: `-m/--model`, `-p/--provider`, `-C/--project`, `--json`, `--host`, `--port`, `-q`.

---

## The AI system — providers & keys

Keys resolve in this order: **provider-specific config** → **generic config apiKey** → **environment**.

| Provider | env var | preset models |
|---|---|---|
| openai | `OPENAI_API_KEY` | gpt-4o, gpt-4o-mini, gpt-4.1, … |
| anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-5, claude-opus-4-1, … |
| google | `GEMINI_API_KEY` | gemini-2.5-flash/pro |
| groq | `GROQ_API_KEY` | llama-3.3-70b-versatile |
| openrouter | `OPENROUTER_API_KEY` | any/* |
| deepseek / mistral / together / xai | …_API_KEY | vendor lists |
| ollama / lmstudio | none (local) | local models |
| mock | none | offline scripted provider (used by tests) |

Switch at runtime: `/provider groq`, `/model llama-3.3-70b-versatile`, or the mobile app's CONF tab (keys are stored in **project-local** config by default, masked in every API response).

---

## The memory system (built for long projects)

Every project gets a private memory workspace at `<project>/.noir/memory/`:

```
memory/
├── notes.md                 # agent's working notes — injected into EVERY session's prompt
├── facts.md                 # durable project facts
└── snapshots/
    ├── <session>-<ts>.json          # FULL transcript, written BEFORE compaction
    ├── summaries/<session>-<ts>.md  # AI-distilled continuation summaries
    └── subagents/<type>-<ts>.json   # every subagent transcript
```

**The compaction contract** (the core of NOIR):

1. When the session exceeds `compactAtTokens` (default 60k), the harness **first writes the complete transcript** to `snapshots/` — nothing is ever silently lost.
2. The AI then distills a **continuation summary** + terse memory notes; the notes are merged into `notes.md`.
3. The session restarts from the summary. `notes.md` is reloaded at the start of every session, so distilled knowledge survives compaction *and* restarts.

Commands: `/memory` (show), `/memory add <text>`, `/memory snapshots`, `/compact` (manual). The agent itself uses `save_memory` / `read_memory` / `list_snapshots` tools. Sessions also autosave (per message) to `.noir/sessions/` — `/sessions`, `/resume <id>`.

## Multi-agent system

- **Subagents** (`spawn_subagent` tool, `/agent` command): isolated context, role-restricted tools — `explore`, `coder`, `researcher`, `writer`, `general` — plus custom roles in `.noir/agents/*.json` (`{"description": "...", "tools": [...], "system": "..."}`). Transcripts land in the memory workspace.
- **Swarm** (`swarm` tool, `/swarm`, `noir swarm`): a planner decomposes the objective into tasks (`research`/`code`/`write`), a parallel worker pool executes them (default 4 workers), a synthesizer merges everything into a report. Boards persist to `.noir/swarm/`.

## MCP system

Add servers to `.noir/config.json` (project) or `~/.noir/config.json` (global):

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "fetch":      { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"], "enabled": true },
    "remote":     { "transport": "http", "url": "https://example.com/mcp" }
  }
}
```

Each remote tool becomes an agent tool named `mcp__<server>__<tool>`. Live tool-list refresh, request timeouts, and non-fatal connect failures are handled. Inspect with `/mcp`, call directly with `call_mcp`.

## Skills

Drop `SKILL.md` packs into `.noir/skills/<name>/SKILL.md` (project) or `~/.noir/skills/` (global). Built-ins ship in the package (`skills/`): **code-review**, **commit**, **debug-loop**. Frontmatter format:

```markdown
---
name: my-skill
description: When to use this skill
---
# Instructions the agent must follow…
```

The list is advertised in the system prompt; `/skill my-skill` or the `use_skill` tool injects the full instructions and marks the skill active for the session.

## Plugins (harness extensions: tools, commands, hooks)

```js
// .noir/plugins/myplugin/plugin.mjs  (.mjs keeps ESM clean in any project)
export default {
  name: "my-plugin",
  setup(ctx) {
    ctx.registerTool({ name: "my_tool", description: "…", parameters: {...}, run: (args) => "…" });
    ctx.registerCommand({ name: "mycmd", description: "…", run: () => "…" });
    ctx.on("tool:end", ({ name, ok }) => ctx.log("info", `${name} ${ok}`));
  },
};
```

`ctx` provides `registerTool`, `registerCommand`, `registerPanel`, `on(event)`, `getConfig()`, `log()`, `projectDir`. Working examples: `plugins/examples/datetime`, `plugins/examples/wordcount`.

## Extensions (UI extensions — mobile-ready)

Extensions contribute **panels** and **commands**. Panels render to text, which the TUI shows as a tab and the mobile app shows as a bottom-nav tab — the same code works everywhere, including Android:

```js
// .noir/extensions/usage/extension.mjs
export default {
  name: "usage",
  contributions: {
    panels: [{ id: "usage", title: "Usage", render: (uiCtx) => `model: ${uiCtx.harness.model}` }],
    commands: [{ name: "usage", description: "stats", run: () => "…" }],
  },
};
```

Examples: `extensions/examples/usage-panel`, `extensions/examples/memory-viewer`. (`setup(ctx)` is available here too if you also want tools.)

## Web search

- Default: **DuckDuckGo HTML** — zero keys, works out of the box.
- `config.search.provider`: `brave` (`BRAVE_API_KEY` / `search.braveKey`), `tavily` (`TAVILY_API_KEY`), `searxng` (`search.searxUrl`), with automatic fallback to DuckDuckGo if an API provider fails.
- `web_fetch` strips HTML to readable text with caps and timeouts.

## Configuration

Precedence: defaults ← `~/.noir/config.json` ← `<project>/.noir/config.json` ← env (`NOIR_PROVIDER`, `NOIR_MODEL`, `NOIR_API_KEY`, `NOIR_HOME`, `NOIR_COMPACT_AT_TOKENS`, provider keys).

`noir init` writes a sample project config. Core keys:

```jsonc
{
  "provider": "openai",            // openai|anthropic|google|groq|openrouter|deepseek|mistral|together|xai|ollama|lmstudio|custom|mock
  "model": "gpt-4o-mini",
  "compactAtTokens": 60000,        // auto-compaction threshold (snapshot saved first!)
  "maxSteps": 60,
  "temperature": 0.4,
  "maxTokens": 8192,
  "shellTimeoutMs": 120000,
  "search": { "provider": "duckduckgo" },
  "server": { "host": "127.0.0.1", "port": 5178 },
  "providers": { "openai": { "apiKey": "…" } }
}
```

## Mobile app (the APP half of the harness)

`noir serve` runs the harness headless and serves a **PWA**:

- **Same device (recommended):** run NOIR in Termux, open `http://127.0.0.1:5178` in Chrome/Firefox on the phone → menu → **Add to Home screen**. It installs with its own icon and runs standalone — offline shell caching included via service worker.
- **From another device on your LAN:** `noir serve --host 0.0.0.0` — a per-run access **token** is printed and required as `?token=…` or `x-noir-token` (loopback binding needs no token).
- The app exposes every harness surface: chat with live streaming + tool chips, built-in terminal, memory workspace viewer, skills, subagent & swarm launchers, sessions, settings (provider/model/key), command palette on `/`.

## Real-world project: NoirPad (runs inside the harness)

`examples/noir-pad/` is a complete, useful app built **for** the harness: a markdown notes app for your phone that runs through the local app and whose notes are **plain `.md` files the NOIR agent can read and write with its standard tools**.

```bash
node examples/noir-pad/install.mjs .   # install into your project
noir serve                             # open http://127.0.0.1:5178 on your phone
# mobile app -> APPS tab -> noirpad -> OPEN
```

- Create/edit/delete notes, tags, full-text search, markdown preview, `.md` import/export, autosave
- Notes live at `.noir/webapps/noirpad/data/notes/*.md` — ask the agent *"what's in my notes tagged work?"* and it reads them directly; it can write notes back that the app displays
- Any project can ship its own web app the same way: drop a static site into `.noir/webapps/<name>/` and NOIR serves it at `/apps/<name>/` with a sandboxed per-app file API (`/api/app-data/<name>`, 512KB/file cap, traversal-rejecting)
- A live interop demo (phone writes → agent reads → agent replies → phone sees it) ships at `examples/noir-pad/interop-demo.mjs`

## Security notes

- **File tools are project-locked**: `read_file` / `write_file` / `edit_file` / `list_files` / `search_files` refuse any path that escapes the project directory (path-traversal and absolute-path attempts included) — the agent cannot be talked into touching files outside the workspace. Shell access via `run_command` remains possible by design, like a terminal.
- Tool results are hard-capped (`toolOutputLimit`, default 60k chars) and `read_file` truncates over-long lines, so one huge output can never blow the context.
- Every tool run is event-logged; malformed provider SSE, crashed MCP servers, and network failures degrade gracefully instead of crashing turns.
- API keys are masked in every API response; project configs keep keys out of your global dotfiles.
- The app binds to 127.0.0.1 by default; non-loopback binds require a per-run access token.

## Testing (production-grade)

```bash
npm test   # 25 suites, 635+ assertions
```

Coverage includes: **wire-protocol emulators** for the OpenAI / Anthropic / Gemini SSE formats (streaming, parallel tool-call assembly, multi-turn tool results, error mapping, malformed-SSE survival, CRLF framing, mid-stream aborts), the full agent loop (step limits, aborts, busy-guards, provider crashes, output caps, tool ordering, role restrictions), the compaction contract (snapshot integrity byte-for-byte, distillation parsing, provider-failure fallback), MCP over stdio **and** HTTP (handshakes, timeouts, crashes, tool registry bridge), server security (token auth, CORS, 404/400/500 handling, oversized bodies, concurrency, config-patch whitelisting, dot-segment traversal rejection), config precedence & env resolution, plugin/extension loading (CJS, npm layouts, async setups, failure isolation), memory & session persistence, subagent + swarm orchestration, **full TUI App boot test** (real app, typed input, slash commands, chat turn, shell passthrough, panel switching), web-app↔server contract drift checks, **web-app hosting + app-data sandbox + NoirPad agent-interop**, PWA manifest installability, strict-monochrome CSS guard, and stress tests (200-message sessions, 60-deep trees, 600-file directories, 60 MCP tools, 8-task swarms). The suite is deterministic — three consecutive runs green.

## Architecture (in one screen)

```
bin/noir.js ─ dist/cli.ts ─┬─ dist/tui/app.tsx        (Ink TUI, monochrome)
                           ├─ dist/server/server.ts   (HTTP + SSE API + PWA host)
                           └─ dist/core/harness.ts    ── the facade ──
        ┌───────────────┬──────────────┬────────────┬─────────────┬───────────────┐
   providers/        agent/          tools/        mcp/         memory/        skills/ modules/
   openai-compatible  loop, compaction, 18 built-ins  JSON-RPC    workspace,     SKILL.md  plugins + extensions
   anthropic, google  subagents, swarm              stdio/http   snapshots      loader    (tools/panels/commands)
```

Zero runtime dependencies beyond `ink` + `react`. Everything else is Node stdlib.

## Tests

```bash
npm test
```

10 suites cover: file tools round-trip, agent loop with tool calls, **compaction + pre-compaction snapshots**, MCP client against a real echo server, skills/plugins/extensions loading, sessions & memory persistence, subagents & swarm orchestration, the HTTP/SSE app server end-to-end, live web search (auto-skips offline), and the CLI (`doctor`, `run`, `models`).

## Roadmap ideas

- PTY-backed interactive terminal sessions (via Termux's shell)
- Remote sync of memory workspaces between devices
- Voice input via Termux API

---

NOIR v0.1.0 — built black & white, on purpose.
