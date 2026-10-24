import { errResult, schema, textResult, type Tool } from "./types.js";

export const skillTools: Tool[] = [
  {
    name: "list_skills",
    description: "List available skills with their descriptions.",
    parameters: schema.obj({}, []),
    readOnly: true,
    run(_args, ctx) {
      const all = ctx.skills.list();
      if (!all.length) return textResult("No skills installed.");
      return textResult(all.map((s) => `${s.id} [${s.source}]\n  ${s.description || "(no description)"}\n  source: ${s.path}`).join("\n"));
    },
  },
  {
    name: "use_skill",
    description:
      "Activate a skill by id. The skill's full instructions are injected for the rest of this session AND returned to you — follow them carefully for the remainder of the task.",
    parameters: schema.obj({
      name: schema.str("Skill id to activate"),
    }, ["name"]),
    run(args, ctx) {
      const name = String(args.name ?? "").trim();
      const skill = ctx.skills.get(name);
      if (!skill) {
        const avail = ctx.skills.list().map((s) => s.id).join(", ") || "(none)";
        return errResult(`Skill "${name}" not found. Available: ${avail}`);
      }
      if (!ctx.session.activeSkillInstructions.includes(skill.id)) {
        ctx.session.activeSkillInstructions.push(skill.id);
      }
      return textResult(
        `SKILL "${skill.id}" ACTIVATED — follow these instructions for the rest of the task:\n\n${skill.body}`
      );
    },
  },
];

export const taskTools: Tool[] = [
  {
    name: "task_board",
    description:
      "Plan and track work on a persistent task board. Actions: list | add {title} | update {id, status: todo|doing|done} | clear. The board is shown to you and the user across turns.",
    parameters: schema.obj({
      action: schema.str("list | add | update | clear"),
      title: schema.str("Task title (for add)"),
      id: schema.str("Task id (for update)"),
      status: schema.str("New status: todo | doing | done"),
    }, ["action"]),
    run(args, ctx) {
      const action = String(args.action ?? "list");
      if (action === "list") {
        const t = ctx.taskBoard.list();
        if (!t.length) return textResult("Task board is empty.");
        return textResult(t.map((x) => `[${x.status === "done" ? "x" : x.status === "doing" ? "~" : " "}] ${x.id}. ${x.title}`).join("\n"));
      }
      if (action === "add") {
        const title = String(args.title ?? "").trim();
        if (!title) return errResult("title required for add");
        const t = ctx.taskBoard.add(title);
        return textResult(`Added task ${t.id}: ${t.title}`);
      }
      if (action === "update") {
        const status = String(args.status ?? "done");
        if (!["todo", "doing", "done"].includes(status)) return errResult(`status must be todo|doing|done`);
        const t = ctx.taskBoard.update(String(args.id ?? ""), status as "todo" | "doing" | "done");
        if (!t) return errResult(`task ${args.id} not found`);
        return textResult(`Task ${t.id} -> ${t.status}`);
      }
      if (action === "clear") {
        ctx.taskBoard.clear();
        return textResult("Task board cleared.");
      }
      return errResult(`unknown action "${action}"`);
    },
  },
];
