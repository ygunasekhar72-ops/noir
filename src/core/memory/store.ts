import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { globalMemoryDir, ensureDir, projectMemoryDir } from "../config.js";
import type { Message } from "../providers/types.js";

/**
 * NOIR memory workspace.
 *
 * Every project gets its own memory workspace at `<project>/.noir/memory/`:
 *   notes.md     — agent working notes, loaded into every session's system prompt
 *   facts.md     — durable long-term facts about the project
 *   snapshots/   — FULL session transcripts written BEFORE compaction, so
 *                  nothing is ever lost when context is squeezed
 *   snapshots/summaries/ — compaction summaries
 *
 * A global workspace at ~/.noir/memory/ carries cross-project knowledge.
 */
export class MemoryStore {
  readonly dir: string;
  readonly globalDir: string;

  constructor(projectDir: string) {
    this.dir = projectMemoryDir(projectDir);
    this.globalDir = globalMemoryDir();
    ensureDir(this.dir);
    ensureDir(join(this.dir, "snapshots"));
    ensureDir(join(this.dir, "snapshots", "summaries"));
    ensureDir(this.globalDir);
  }

  private p(file: string): string {
    return join(this.dir, file);
  }

  private g(file: string): string {
    return join(this.globalDir, file);
  }

  notesPath(): string {
    return this.p("notes.md");
  }

  factsPath(): string {
    return this.p("facts.md");
  }

  private read(file: string): string {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  }

  readNotes(): string {
    return this.read(this.notesPath());
  }

  readFacts(): string {
    return this.read(this.factsPath());
  }

  readGlobalNotes(): string {
    return this.read(this.g("notes.md"));
  }

  appendNote(note: string, file: "notes" | "facts" | "global" = "notes"): string {
    const path = file === "facts" ? this.factsPath() : file === "global" ? this.g("notes.md") : this.notesPath();
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    appendFileSync(path, `\n- [${stamp}] ${note.trim()}\n`, "utf8");
    return path;
  }

  setNotes(content: string): string {
    writeFileSync(this.notesPath(), content.trim() + "\n", "utf8");
    return this.notesPath();
  }

  /** Full context block injected into the system prompt. */
  contextBlock(maxChars = 6000): string {
    const parts: string[] = [];
    const notes = this.readNotes().trim();
    const facts = this.readFacts().trim();
    const global = this.readGlobalNotes().trim();
    if (notes) parts.push(`### Project notes (notes.md)\n${clip(notes, maxChars / 2)}`);
    if (facts) parts.push(`### Project facts (facts.md)\n${clip(facts, maxChars / 4)}`);
    if (global) parts.push(`### Global notes\n${clip(global, maxChars / 4)}`);
    return parts.join("\n\n");
  }

  /**
   * CRITICAL: persist the full transcript BEFORE compaction destroys detail.
   * Returns the snapshot path.
   */
  snapshotBeforeCompaction(sessionId: string, messages: Message[]): string {
    const dir = join(this.dir, "snapshots");
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${sessionId}-${ts}.json`);
    const payload = {
      kind: "pre-compaction-snapshot",
      sessionId,
      savedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    return path;
  }

  saveCompactionSummary(sessionId: string, summary: string): string {
    const dir = join(this.dir, "snapshots", "summaries");
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${sessionId}-${ts}.md`);
    writeFileSync(path, `# Compaction summary — ${sessionId}\n\n${summary}\n`, "utf8");
    return path;
  }

  saveSubagentTranscript(subagent: string, task: string, messages: Message[]): string {
    const dir = join(this.dir, "snapshots", "subagents");
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${subagent}-${ts}.json`);
    writeFileSync(path, JSON.stringify({ subagent, task, savedAt: new Date().toISOString(), messages }, null, 2), "utf8");
    return path;
  }

  listSnapshots(): Array<{ file: string; size: number; when: string }> {
    const out: Array<{ file: string; size: number; when: string }> = [];
    for (const sub of ["snapshots", join("snapshots", "summaries"), join("snapshots", "subagents")]) {
      const dir = join(this.dir, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") && !f.endsWith(".md")) continue;
        const full = join(dir, f);
        const st = statSync(full);
        const label = `${sub.split(sep).join("/")}/${f}`;
        out.push({ file: label, size: st.size, when: st.mtime.toISOString() });
      }
    }
    return out.sort((a, b) => b.when.localeCompare(a.when));
  }

  /** Editor hook: rewrite notes with AI-distilled content during compaction. */
  distillToNotes(distill: string): string {
    const existing = this.readNotes();
    const header = "# NOIR project memory — distilled " + new Date().toISOString().slice(0, 10) + "\n";
    const merged = (existing.trim() && !existing.startsWith("# NOIR project memory")
      ? header + "\n" + existing.trim() + "\n\n## Distilled update\n" + distill.trim() + "\n"
      : header + "\n" + (existing.trim() ? existing.trim() + "\n\n" : "") + "## Distilled update\n" + distill.trim() + "\n");
    return this.setNotes(merged.slice(0, 20000));
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(older notes trimmed)";
}
