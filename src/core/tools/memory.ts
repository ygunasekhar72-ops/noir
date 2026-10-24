import { errResult, schema, textResult, type Tool } from "./types.js";

export const memoryTools: Tool[] = [
  {
    name: "save_memory",
    description:
      "Persist an important note to the project memory workspace (.noir/memory/). Notes are reloaded into every future session — use this for decisions, facts, conventions, API endpoints, usernames, anything that must survive compaction.",
    parameters: schema.obj({
      note: schema.str("The note to remember, dense and self-contained"),
      kind: schema.str("Where to store: \"notes\" (working notes, default), \"facts\" (durable project facts), \"global\" (cross-project)"),
    }, ["note"]),
    run(args, ctx) {
      const note = String(args.note ?? "").trim();
      if (!note) return errResult("note is required");
      const kind = String(args.kind ?? "notes");
      const valid = kind === "notes" || kind === "facts" || kind === "global";
      if (!valid) return errResult(`kind must be notes|facts|global, got "${kind}"`);
      const path = ctx.memory.appendNote(note, kind as "notes" | "facts" | "global");
      return textResult(`Saved to ${kind} memory: ${path}`);
    },
  },
  {
    name: "read_memory",
    description: "Read the project memory workspace (notes, facts, global notes, and the latest compaction summary if any).",
    parameters: schema.obj({}, []),
    readOnly: true,
    run(_args, ctx) {
      const notes = ctx.memory.readNotes();
      const facts = ctx.memory.readFacts();
      const global = ctx.memory.readGlobalNotes();
      const block =
        `### Project notes\n${notes || "(empty)"}\n\n### Project facts\n${facts || "(empty)"}\n\n### Global notes\n${global || "(empty)"}`;
      return textResult(block);
    },
  },
  {
    name: "list_snapshots",
    description: "List saved memory snapshots (full transcripts persisted before compaction) in this project's memory workspace.",
    parameters: schema.obj({}, []),
    readOnly: true,
    run(_args, ctx) {
      const snaps = ctx.memory.listSnapshots();
      if (!snaps.length) return textResult("No snapshots yet. Snapshots are written automatically before every compaction.");
      return textResult(snaps.map((s) => `- ${s.file} (${fmtBytes(s.size)}, ${s.when.slice(0, 16).replace("T", " ")})`).join("\n"));
    },
  },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
