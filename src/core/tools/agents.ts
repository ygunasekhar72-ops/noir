import { errResult, schema, textResult, type Tool } from "./types.js";

export const subagentTools: Tool[] = [
  {
    name: "spawn_subagent",
    description:
      "Spawn a fresh subagent with its own clean context to complete a sub-task and report back. Types: explore (read-only codebase/search), coder (files+shell), researcher (web), writer (docs), general (all tools). Use for isolation, parallelizable research, or heavy context gathering without polluting the main context.",
    parameters: schema.obj({
      agent: schema.str("Subagent type: explore | coder | researcher | writer | general"),
      task: schema.str("Complete, self-contained instruction for the subagent"),
      description: schema.str("One-line description shown to the user"),
      timeoutMs: schema.num("Timeout (default 10 min)"),
    }, ["agent", "task"]),
    run(args, ctx) {
      const type = String(args.agent ?? "general");
      const task = String(args.task ?? "").trim();
      if (!task) return errResult("task is required");
      return ctx.subagents
        .run(type, task, {
          description: args.description ? String(args.description) : undefined,
          timeoutMs: Number(args.timeoutMs ?? 600000),
        })
        .then((r) => (r.error ? errResult(`subagent "${type}" failed: ${r.error}`) : textResult(r.result)));
    },
  },
];

export const swarmTools: Tool[] = [
  {
    name: "swarm",
    description:
      "Run a multi-agent swarm on an objective: a planner decomposes it into tasks, parallel worker subagents execute them (research/code/write), and a synthesizer merges results into a final report. Use for large goals that benefit from parallelism.",
    parameters: schema.obj({
      objective: schema.str("The overall objective for the swarm"),
      workers: schema.num("Parallel workers (default 4)"),
    }, ["objective"]),
    run(args, ctx) {
      const objective = String(args.objective ?? "").trim();
      if (!objective) return errResult("objective is required");
      return ctx.swarm
        .run(objective, { workers: Number(args.workers ?? 4) })
        .then((report) => textResult(report))
        .catch((err) => errResult(`swarm failed: ${(err as Error).message}`));
    },
  },
];
