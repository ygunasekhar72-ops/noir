import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectSessionsDir, ensureDir } from "./config.js";
import type { Message } from "./providers/types.js";

export interface Task {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
}

export interface SessionData {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  messages: Message[];
  taskBoard: Task[];
  activeSkillInstructions: string[];
  subagent?: boolean;
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A conversation session bound to a project directory, persisted under .noir/sessions/. */
export class Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  messages: Message[] = [];
  taskBoard: Task[] = [];
  activeSkillInstructions: string[] = [];
  subagent: boolean;
  readonly projectDir: string;

  constructor(projectDir: string, data?: Partial<SessionData>) {
    this.projectDir = projectDir;
    this.id = data?.id ?? newSessionId();
    this.title = data?.title ?? "new session";
    this.createdAt = data?.createdAt ?? new Date().toISOString();
    this.updatedAt = data?.updatedAt ?? this.createdAt;
    this.provider = data?.provider ?? "openai";
    this.model = data?.model ?? "gpt-4o-mini";
    this.messages = data?.messages ?? [];
    this.taskBoard = data?.taskBoard ?? [];
    this.activeSkillInstructions = data?.activeSkillInstructions ?? [];
    this.subagent = data?.subagent ?? false;
  }

  /** Rough token estimate (~4 chars/token). */
  estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      chars += typeof m.content === "string" ? m.content.length : 0;
      if (m.role === "assistant" && m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    }
    return Math.ceil(chars / 4);
  }

  push(m: Message): void {
    this.messages.push(m);
    this.updatedAt = new Date().toISOString();
    if (this.title === "new session" && m.role === "user" && m.content) {
      this.title = m.content.slice(0, 48).replace(/\s+/g, " ");
    }
  }

  save(): void {
    if (this.subagent) return; // subagent transcripts live in the memory workspace instead
    const dir = projectSessionsDir(this.projectDir);
    ensureDir(dir);
    const data: SessionData = {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      provider: this.provider,
      model: this.model,
      messages: this.messages,
      taskBoard: this.taskBoard,
      activeSkillInstructions: this.activeSkillInstructions,
      subagent: false,
    };
    writeFileSync(join(dir, `${this.id}.json`), JSON.stringify(data, null, 2), "utf8");
  }

  static list(projectDir: string): Array<{ id: string; title: string; updatedAt: string; messageCount: number; tokens: number }> {
    const dir = projectSessionsDir(projectDir);
    if (!existsSync(dir)) return [];
    const out: Array<{ id: string; title: string; updatedAt: string; messageCount: number; tokens: number }> = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionData;
        out.push({
          id: d.id,
          title: d.title,
          updatedAt: d.updatedAt,
          messageCount: d.messages?.length ?? 0,
          tokens: Math.ceil(JSON.stringify(d.messages ?? []).length / 4),
        });
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static load(projectDir: string, id: string): Session | null {
    const path = join(projectSessionsDir(projectDir), `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      const d = JSON.parse(readFileSync(path, "utf8")) as SessionData;
      return new Session(projectDir, { ...d, subagent: false });
    } catch {
      return null;
    }
  }

  /** Fresh in-memory session for subagent runs (not persisted as a main session). */
  static ephemeral(projectDir: string, opts: Partial<SessionData> = {}): Session {
    const s = new Session(projectDir, { ...opts, id: newSessionId(), subagent: true });
    return s;
  }

  /** Session dir used by memory snapshots for this session id. */
  static ensureProjectDir(projectDir: string): string {
    mkdirSync(join(projectDir, ".noir"), { recursive: true });
    return join(projectDir, ".noir");
  }
}
