import type { Config } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { MemoryStore } from "../memory/store.js";
import type { Session } from "../session.js";
import type { SkillManager } from "../skills/manager.js";
import type { AIProvider } from "../providers/index.js";
import type { Message } from "../providers/types.js";
import type { ToolCtx, ToolRegistry } from "../tools/index.js";
import { Compactor } from "./compaction.js";

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "message"; message: Message }
  | { type: "tool"; phase: "start" | "end"; name: string; args?: Record<string, unknown>; result?: string; ok?: boolean }
  | { type: "compaction"; phase: "start" | "saved" | "summarizing" | "done"; detail?: string }
  | { type: "note"; text: string }
  | { type: "done"; reason: "end" | "step-limit" | "aborted" };

export interface AgentDeps {
  provider: AIProvider;
  model: string;
  session: Session;
  registry: ToolRegistry;
  config: Config;
  memory: MemoryStore;
  skills: SkillManager;
  events: EventBus;
  logger: Logger;
  /** Fresh tool context bound to a session (harness provides; subagents pass their own session). */
  makeCtx: (session: Session) => ToolCtx;
  /** Restrict the toolset (subagent roles). */
  allowedTools?: string[];
  /** Extra system prompt (subagent persona, swarm roles...). */
  systemExtra?: string;
  signal?: AbortSignal;
  /** Disable auto-compaction (subagents: compaction is handled at a higher level if needed). */
  autoCompact?: boolean;
}

/** The core agent loop: user input -> provider -> tools -> repeat, with auto-compaction. */
export class Agent {
  private deps: AgentDeps;
  private compactor: Compactor;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.compactor = new Compactor({
      provider: deps.provider,
      model: deps.model,
      memory: deps.memory,
      events: deps.events,
      logger: deps.logger,
    });
  }

  buildSystemPrompt(): string {
    const { config, session, memory, skills } = this.deps;
    const ctxInfo: string[] = [
      `Platform: ${process.platform} (${process.arch}) — on Android this is Termux`,
      `Project directory: ${session.projectDir}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Model: ${this.deps.provider.id}/${this.deps.model}`,
    ];
    const parts: string[] = [];

    parts.push(
      `You are NOIR, a capable AI agent running inside the NOIR harness — a terminal + mobile agent platform.\n\n## Environment\n${ctxInfo.join("\n")}`
    );

    const mem = memory.contextBlock();
    if (mem) parts.push(`## Memory (loaded from the project memory workspace — this is durable, pre-compaction knowledge)\n${mem}`);

    const skillBlock = skills.systemBlock();
    if (skillBlock) parts.push(`## Skills\n${skillBlock}`);

    const active = session.activeSkillInstructions
      .map((id) => skills.get(id))
      .filter(Boolean)
      .map((s) => `### Active skill: ${s!.id}\n${s!.body}`);
    if (active.length) parts.push(`## Active skill instructions\n${active.join("\n\n")}`);

    if (session.taskBoard.length) {
      parts.push(
        `## Task board\n${session.taskBoard.map((t) => `- [${t.status}] ${t.id}. ${t.title}`).join("\n")}`
      );
    }

    parts.push(TOOL_POLICY);

    if (this.deps.systemExtra) parts.push(this.deps.systemExtra);
    return parts.join("\n\n");
  }

  private toolFilter(): (name: string) => boolean {
    const allow = this.deps.allowedTools;
    return allow ? (name: string) => allow.includes(name) : () => true;
  }

  /** Main entry: run one user turn to completion, streaming events. */
  async *run(userInput: string): AsyncGenerator<AgentEvent, void, unknown> {
    const { session, registry, provider, model, config, logger, events, signal } = this.deps;
    const filter = this.toolFilter();
    const maxSteps = config.maxSteps ?? 60;
    const compactAt = config.compactAtTokens ?? 60000;

    session.push({ role: "user", content: userInput });
    session.save();
    events.pub("agent:start", { input: userInput });

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }

      // auto-compaction check BEFORE provider call (memory is always saved first).
      // Guard: need at least restore+user+one more message to avoid compacting a fresh restore.
      if (this.deps.autoCompact !== false && session.estimateTokens() > compactAt && session.messages.length >= 3) {
        yield { type: "compaction", phase: "start" };
        try {
          const r = await this.compactor.compact(session);
          yield { type: "compaction", phase: "saved", detail: r.snapshotPath };
          yield { type: "compaction", phase: "done", detail: r.summaryPath };
          yield { type: "note", text: `session compacted (snapshot: ${r.snapshotPath})` };
        } catch (err) {
          logger.warn(`auto-compaction failed: ${(err as Error).message}`);
          yield { type: "note", text: `compaction failed: ${(err as Error).message}` };
        }
      }

      const messages: Message[] = [{ role: "system", content: this.buildSystemPrompt() }, ...session.messages];
      const tools = registry.defs((t) => filter(t.name));

      let content = "";
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      try {
        for await (const ev of provider.stream({
          messages,
          tools,
          model,
          signal,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        })) {
          if (ev.type === "text") {
            content += ev.text;
            yield { type: "delta", text: ev.text };
          } else if (ev.type === "toolCall") {
            toolCalls.push(ev.toolCall);
          }
        }
      } catch (err) {
        if (signal?.aborted || (err as Error).name === "AbortError" || /aborted/i.test((err as Error).message)) {
          yield { type: "note", text: "generation aborted" };
          yield { type: "done", reason: "aborted" };
          return;
        }
        throw err;
      }

      const assistantMsg: Message = toolCalls.length
        ? { role: "assistant", content, toolCalls }
        : { role: "assistant", content };
      session.push(assistantMsg);
      session.save();
      yield { type: "message", message: assistantMsg };
      events.pub("agent:message", { role: "assistant", content });

      if (toolCalls.length === 0) {
        // turn complete — compact now if oversized so the next turn starts clean
        if (this.deps.autoCompact !== false && session.estimateTokens() > compactAt) {
          yield { type: "compaction", phase: "start" };
          try {
            const r = await this.compactor.compact(session);
            yield { type: "compaction", phase: "saved", detail: r.snapshotPath };
            yield { type: "compaction", phase: "done", detail: r.summaryPath };
          } catch (err) {
            logger.warn(`auto-compaction (post-turn) failed: ${(err as Error).message}`);
          }
        }
        yield { type: "done", reason: "end" };
        return;
      }

      // execute tools sequentially (predictable, safe on mobile)
      const ctx = this.deps.makeCtx(session);
      for (const tc of toolCalls) {
        if (signal?.aborted) {
          yield { type: "note", text: "tool execution aborted" };
          yield { type: "done", reason: "aborted" };
          return;
        }
        const allowed = filter(tc.name);
        events.pub("tool:start", { name: tc.name, args: tc.arguments });
        yield { type: "tool", phase: "start", name: tc.name, args: tc.arguments };
        let result: { content: string; isError?: boolean };
        if (!allowed) {
          result = { content: `Tool "${tc.name}" is not available for this agent role.`, isError: true };
        } else {
          result = await registry.execute(tc.name, tc.arguments ?? {}, ctx);
        }
        // cap tool results so one huge output cannot blow the context
        const limit = config.toolOutputLimit ?? 60000;
        if (result.content.length > limit) {
          result = { ...result, content: result.content.slice(0, limit) + `\n…(truncated at ${limit} chars — page with offset/limit or narrow your query)` };
        }
        const toolMsg: Message = { role: "tool", toolCallId: tc.id, name: tc.name, content: result.content, ...(result.isError ? { isError: true } : {}) };
        session.push(toolMsg);
        session.save();
        events.pub("tool:end", { name: tc.name, ok: !result.isError, result: result.content });
        yield { type: "tool", phase: "end", name: tc.name, result: result.content.slice(0, 4000), ok: !result.isError };
      }
    }

    yield { type: "note", text: `step limit reached (${maxSteps}) — ask the user how to proceed` };
    yield { type: "done", reason: "step-limit" };
  }
}

const TOOL_POLICY = `## Tool policy
- Prefer tools over guessing: read files before editing, run commands to verify, search the web for current facts.
- edit_file: match exact existing text; include enough context to be unique. Never guess file contents.
- Keep outputs lean: page through big files with offset/limit; use search_files over reading whole trees.
- Use task_board to plan multi-step work; update statuses as you go.
- Delegate isolated, context-heavy subtasks to spawn_subagent; use swarm for big parallelizable objectives.
- Persist anything that must survive compaction with save_memory (notes survive; raw context does not).
- Run shell commands with run_command. On Android (Termux) standard coreutils are available.
- Be concise and factual. Terse, high-signal answers.`;
