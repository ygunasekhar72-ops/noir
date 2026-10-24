# Changelog

All notable changes to NOIR are documented here.

## [0.1.0] — 2026-10-24

### Added
- **Project web apps**: any static site in `<project>/.noir/webapps/<name>/` is served by `noir serve` at `/apps/<name>/`, listed in `/api/state`, browsable from the mobile app's APPS tab, and gets a sandboxed file API (`GET/POST/DELETE /api/app-data/<name>` with traversal rejection and a 512KB/file cap). Ships **NoirPad** (`examples/noir-pad/`) — a real markdown notes app whose notes are plain `.md` files the agent reads/writes with its normal tools, plus a live interop demo (`interop-demo.mjs`) and an `/apps` TUI command.
- Terminal TUI (Ink, strict monochrome) with chat, built-in terminal, memory, skills and agents panels; tab switching, input history, abort, double-ctrl+c exit.
- Mobile PWA app (`noir serve`) — chat with live streaming + tool chips, terminal, memory workspace viewer, skills, subagent/swarm launchers, sessions, settings, command palette; installable via "Add to Home screen" with service-worker shell caching.
- 18 built-in tools: read/write/edit files, glob, grep, shell, web_search, web_fetch, save/read memory, snapshots, task board, skills, subagents, swarm, MCP bridge.
- AI providers: OpenAI-compatible (OpenAI, Groq, OpenRouter, DeepSeek, Mistral, Together, xAI, Ollama, LM Studio, custom), Anthropic Messages, Google Gemini; SSE streaming, tool calls, usage accounting.
- MCP client (JSON-RPC 2.0) with stdio + streamable-HTTP transports; server tools registered as first-class agent tools; live tool-list refresh; timeout & crash isolation.
- Plugin system (tools, commands, hooks) and extension system (UI panels + commands) with CJS/ESM/npm-package support and failure isolation.
- Skills: SKILL.md packs with YAML frontmatter (project / global / built-in tiers); ships code-review, commit, debug-loop.
- Subagents (explore, coder, researcher, writer, general + custom roles via `.noir/agents/*.json`) with role-restricted toolsets and persisted transcripts.
- Multi-agent swarms: planner → parallel worker pool → synthesizer; boards persisted to `.noir/swarm/`; graceful fallback on planner failure.
- Memory workspace per project (`<project>/.noir/memory/`): notes.md, facts.md, **full transcript snapshots written before every compaction**, distilled summaries, subagent transcripts; global cross-project memory.
- Compaction: snapshot-first guarantee, AI distillation (summary + notes parsing), provider-failure fallback, anti-loop guard.
- Sessions: per-project persistence, list/resume, auto titles, task board.
- Web search: DuckDuckGo (keyless) with Brave / Tavily / SearxNG providers and automatic fallback.
- CLI: `noir` (TUI), `serve`, `run` (incl. `--json` event stream), `chat` REPL, `agent`, `swarm`, `sessions`, `skills`, `plugins`, `extensions`, `mcp`, `tools`, `memory`, `models`, `doctor`, `init`, `version`, `help`.

### Security
- File tools locked to the project directory (path-traversal and absolute-path escape attempts rejected with guidance).
- API keys masked in every API response; config-patch whitelist on the app server.
- Non-loopback app-server binds require a per-run access token; loopback binds stay token-free for same-device use.

### Hardening (pre-release test campaign, 580+ assertions / 23 suites)
- SSE parser: CRLF framing support, malformed data lines skipped without killing streams.
- `write_file`/`read_file`/`edit_file`: reject missing/non-string paths (previously a missing path could create a file literally named `undefined`); CRLF normalization; per-line truncation for huge single-line files.
- Glob engine rewritten: correct `**` / `*` / `?` / `{a,b}` brace alternation semantics.
- Tool output hard cap (`toolOutputLimit`) + long-line truncation to protect context.
- `/api/config` now syncs the live model via `setModel` (config and runtime no longer diverge).
- MCP HTTP timeouts produce clear error messages; crashed servers no longer wedge pending calls.
- Plugin/extension `setup()` promises are awaited before the harness reports ready.
- CLI boolean flags (`--json`, `--open`, …) no longer swallow the following argument.
- Empty chat input guarded; busy-guard verified under concurrency.
