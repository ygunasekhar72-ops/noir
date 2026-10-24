/**
 * NOIR extension example: "memory viewer"
 * Copy to <project>/.noir/extensions/memory-viewer/extension.js
 *
 * A panel that surfaces the project memory workspace (notes + snapshots),
 * plus a /recall command that appends a note directly.
 */
export default {
  name: "memory-viewer",
  version: "1.0.0",
  description: "Memory workspace viewer panel",

  contributions: {
    commands: [
      {
        name: "recall",
        description: "Append a note to project memory: /recall <text>",
        run(args, uiCtx) {
          const h = uiCtx.harness;
          const note = args.join(" ").trim();
          if (!note) return "usage: /recall <text>";
          const path = h.memory.appendNote(note, "notes");
          return `saved to ${path}`;
        },
      },
    ],
    panels: [
      {
        id: "memory-viewer",
        title: "Mem Viewer",
        async render(uiCtx) {
          const h = uiCtx.harness;
          const notes = h.memory.readNotes();
          const snaps = h.memory.listSnapshots();
          return [
            "── notes.md ────────────────",
            notes || "(empty)",
            "",
            `── snapshots (${snaps.length}) ──────`,
            ...snaps.slice(0, 10).map((s) => `${s.file}  ${(s.size / 1024).toFixed(1)}KB`),
          ].join("\n");
        },
      },
    ],
  },
};
