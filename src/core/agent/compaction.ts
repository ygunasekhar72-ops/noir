import type { MemoryStore } from "../memory/store.js";
import type { Session } from "../session.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import type { AIProvider } from "../providers/index.js";
import { completeText } from "../providers/index.js";
import type { Message } from "../providers/types.js";

export const COMPACTION_SYSTEM =
  "You are the memory subsystem of NOIR, an AI agent harness. You distill conversations into dense working memory so a fresh AI instance can continue without losing anything important.";

export const COMPACTION_PROMPT = (transcript: string) => `Distill the following agent session into a continuation summary. A fresh AI instance receives ONLY your output as context and must seamlessly continue the user's work.

Include:
- The user's objective(s) and current status
- Decisions made and the reasoning behind them
- Important file paths, function/class names, commands, URLs, API endpoints
- Open tasks and concrete next steps
- Any pitfalls or constraints discovered

Format exactly as:
SUMMARY:
<dense markdown summary, ~800 words max>

NOTES:
<3-8 terse bullet lines worth persisting to the project memory notes.md, each on its own line starting with "- ", or the single word NONE if this exchange contained nothing durable>

TRANSCRIPT:
${transcript}`;

export interface CompactionResult {
  summary: string;
  snapshotPath: string;
  summaryPath?: string;
}

/**
 * The compactor — guardian of the "memory saved BEFORE compaction" contract:
 *   1. persist a FULL transcript snapshot to the project memory workspace
 *   2. ask the model to distill a continuation summary (+ notes)
 *   3. append distilled notes to the project's notes.md
 *   4. reset the session to the continuation summary
 */
export class Compactor {
  constructor(
    private deps: {
      provider: AIProvider;
      model: string;
      memory: MemoryStore;
      events: EventBus;
      logger: Logger;
    }
  ) {}

  async compact(session: Session): Promise<CompactionResult> {
    const { provider, model, memory, events, logger } = this.deps;

    // 1. FULL snapshot BEFORE anything is discarded — the core memory guarantee.
    const snapshotPath = memory.snapshotBeforeCompaction(session.id, session.messages);
    events.pub("compaction", { phase: "saved", detail: snapshotPath });
    logger.info(`compaction: full snapshot saved -> ${snapshotPath}`);

    // 2. distill
    let summary = "";
    let notes: string[] = [];
    try {
      const transcript = session.messages
        .map((m) => renderMessage(m))
        .join("\n\n")
        .slice(0, 240000);
      const out = await completeText(provider, model, COMPACTION_PROMPT(transcript), { system: COMPACTION_SYSTEM, maxTokens: 4096, temperature: 0 });
      const parsed = parseSummary(out);
      summary = parsed.summary;
      notes = parsed.notes;
    } catch (err) {
      logger.warn(`compaction: model distillation failed (${(err as Error).message}); using fallback summary`);
      summary =
        `Auto-compacted after ${session.messages.length} messages. ` +
        `Session topic: ${session.title}. ` +
        `The FULL transcript is preserved at ${snapshotPath}. ` +
        `Read the latest context with read_memory / list_snapshots and ask the user what to continue.`;
    }

    // 3. persist summary + notes
    const summaryPath = memory.saveCompactionSummary(session.id, summary);
    if (notes.length > 0) {
      for (const n of notes) memory.appendNote(n, "notes");
      logger.info(`compaction: ${notes.length} note(s) merged into project memory`);
    }

    // 4. reset session to continuation context
    const restore: Message = {
      role: "user",
      content:
        `[SESSION RESTORED AFTER COMPACTION]\n\nThe previous conversation was compacted, but its full transcript and distilled memory are saved in the project memory workspace.\n\nCONTINUATION SUMMARY:\n${summary}\n\nContinue serving the user seamlessly. Do not mention compaction unless asked.`,
    };
    session.messages = [restore];
    session.save();

    events.pub("compaction", { phase: "done", detail: summaryPath });
    return { summary, snapshotPath, summaryPath };
  }
}

function renderMessage(m: Message): string {
  switch (m.role) {
    case "user":
      return `USER: ${m.content}`;
    case "assistant":
      return `ASSISTANT: ${m.content}${m.toolCalls?.length ? `\n[tool calls: ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments).slice(0, 400)})`).join("; ")}]` : ""}`;
    case "tool":
      return `TOOL ${m.name}: ${m.content.slice(0, 2000)}`;
    default:
      return "";
  }
}

function parseSummary(out: string): { summary: string; notes: string[] } {
  const notesMatch = out.match(/NOTES:\s*([\s\S]*)$/i);
  let summary = out;
  if (notesMatch) {
    summary = out.slice(0, notesMatch.index ?? 0);
    const notesBlock = notesMatch[1].trim();
    const notes =
      notesBlock.toUpperCase() === "NONE"
        ? []
        : notesBlock
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("-"))
            .map((l) => l.replace(/^-\s*/, "").slice(0, 500));
    return { summary: clean(summary), notes };
  }
  return { summary: clean(summary), notes: [] };
}

function clean(s: string): string {
  return s.replace(/^\s*SUMMARY:\s*/i, "").trim() || "(empty summary)";
}
