/**
 * NOIR plugin example: "wordcount"
 * Copy to <project>/.noir/plugins/wordcount/plugin.js
 *
 * Demonstrates a plugin tool that reads project files.
 * Note: plugin tools are sandboxed by the same tool context as builtin tools.
 */
export default {
  name: "wordcount",
  version: "1.0.0",
  description: "Counts words/lines in a file.",

  setup(ctx) {
    ctx.registerTool({
      name: "word_count",
      description: "Count words, lines and characters in a text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project" },
        },
        required: ["path"],
      },
      readOnly: true,
      async run(args) {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        try {
          const text = await readFile(resolve(ctx.projectDir, String(args.path ?? "")), "utf8");
          const words = text.split(/\s+/).filter(Boolean).length;
          return `${args.path}: ${words} words, ${text.split(/\r?\n/).length} lines, ${text.length} chars`;
        } catch (err) {
          throw new Error(`word_count: ${(err).message}`);
        }
      },
    });
  },
};
