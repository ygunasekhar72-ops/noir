import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { EventBus } from "../events.js";
import type { Logger } from "../logger.js";
import { completeText, type AIProvider } from "../providers/index.js";
import type { SubagentRunner } from "./subagents.js";

export interface SwarmTask {
  id: number;
  kind: "research" | "code" | "write" | "general";
  instruction: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
}

const KIND_TO_AGENT: Record<SwarmTask["kind"], string> = {
  research: "researcher",
  code: "coder",
  write: "writer",
  general: "general",
};

const PLANNER_SYSTEM =
  "You are the planner of an AI agent swarm. You decompose objectives into independent, self-contained tasks for worker agents. You output ONLY a task list, nothing else.";

const PLANNER_PROMPT = (objective: string, max: number) => `Objective: ${objective}

Decompose this into at most ${max} independent tasks for parallel workers. Each task must be fully self-contained (a worker sees nothing else).
Output one task per line, exactly in this format:
- [research] <task using web search>
- [code] <task editing files / running commands>
- [write] <task writing docs/prose>
- [general] <any other task>

Use the bracket tag that fits. No numbering, no extra text, no blank lines.`;

const SYNTH_SYSTEM =
  "You are the synthesizer of an AI agent swarm. You merge worker reports into one coherent, actionable final report.";

const SYNTH_PROMPT = (objective: string, reports: string) => `Objective: ${objective}

Worker reports:
${reports}

Write the final consolidated report for the user: outcome, what was done (by which worker), key findings, files/commands produced, and remaining recommendations. Markdown. Dense and factual.`;

export interface SwarmDeps {
  provider: AIProvider;
  model: string;
  config: Config;
  subagents: SubagentRunner;
  events: EventBus;
  logger: Logger;
  projectDir: string;
}

/**
 * Multi-agent swarm: plan -> parallel workers (subagent pool) -> synthesize.
 * The board is persisted to .noir/swarm/ for auditability.
 */
export class SwarmRunner {
  constructor(private deps: SwarmDeps) {}

  async run(objective: string, opts: { workers?: number } = {}): Promise<string> {
    const { provider, model, subagents, events, logger, projectDir } = this.deps;
    const workers = Math.max(1, Math.min(opts.workers ?? 4, 8));

    // ---- 1. plan
    events.pub("swarm", { phase: "plan", detail: objective });
    let tasks: SwarmTask[] = [];
    try {
      const plan = await completeText(provider, model, PLANNER_PROMPT(objective, 6), {
        system: PLANNER_SYSTEM,
        temperature: 0,
        maxTokens: 2048,
      });
      tasks = parsePlan(plan);
    } catch (err) {
      logger.warn(`swarm planner failed: ${(err as Error).message} — falling back to single general worker`);
    }
    if (tasks.length === 0) {
      tasks = [{ id: 1, kind: "general", instruction: objective, status: "pending" }];
    }

    const board = { objective, startedAt: new Date().toISOString(), tasks };
    const swarmDir = join(projectDir, ".noir", "swarm");
    const persist = () => {
      try {
        mkdirSync(swarmDir, { recursive: true });
        writeFileSync(join(swarmDir, `swarm-${board.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(board, null, 2), "utf8");
      } catch {
        /* best-effort */
      }
    };
    persist();

    // ---- 2. parallel worker pool
    events.pub("swarm", { phase: "work", detail: `${tasks.length} task(s), ${workers} parallel workers` });
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const i = cursor++;
        const t = tasks[i];
        t.status = "running";
        events.pub("swarm", { phase: "work", detail: `worker ${KIND_TO_AGENT[t.kind]} -> ${t.instruction.slice(0, 80)}` });
        try {
          const r = await subagents.run(KIND_TO_AGENT[t.kind], t.instruction, {
            description: `swarm task ${t.id}`,
            timeoutMs: 8 * 60 * 1000,
          });
          if (r.error) {
            t.status = "failed";
            t.result = `error: ${r.error}`;
          } else {
            t.status = "done";
            t.result = r.result;
          }
        } catch (err) {
          t.status = "failed";
          t.result = `error: ${(err as Error).message}`;
        }
        persist();
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, () => runNext()));

    // ---- 3. synthesize
    events.pub("swarm", { phase: "synthesize", detail: "merging worker reports" });
    const reports = tasks
      .map((t) => `## Task ${t.id} [${t.kind}] (${t.status}) — ${t.instruction}\n${t.result ?? "(no output)"}`)
      .join("\n\n");
    let report: string;
    try {
      report = await completeText(provider, model, SYNTH_PROMPT(objective, reports.slice(0, 60000)), {
        system: SYNTH_SYSTEM,
        maxTokens: 4096,
      });
    } catch (err) {
      logger.warn(`swarm synthesizer failed: ${(err as Error).message}`);
      report = `# Swarm report (raw)\n\nObjective: ${objective}\n\n${reports}`;
    }

    board.tasks = tasks;
    persist();
    events.pub("swarm", { phase: "done", detail: `${tasks.filter((t) => t.status === "done").length}/${tasks.length} workers succeeded` });
    return report;
  }
}

function parsePlan(plan: string): SwarmTask[] {
  const out: SwarmTask[] = [];
  const seen = new Set<string>();
  for (const line of plan.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([a-z]+)\]\s*(.+)$/i);
    if (!m) continue;
    const kindRaw = m[1].toLowerCase();
    const kind: SwarmTask["kind"] =
      kindRaw === "research" || kindRaw === "code" || kindRaw === "write" ? (kindRaw as SwarmTask["kind"]) : "general";
    const instruction = m[2].trim();
    if (!instruction || seen.has(instruction)) continue;
    seen.add(instruction);
    out.push({ id: out.length + 1, kind, instruction, status: "pending" });
  }
  return out.slice(0, 8);
}
