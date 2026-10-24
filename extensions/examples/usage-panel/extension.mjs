/**
 * NOIR extension example: "usage panel"
 * Copy to <project>/.noir/extensions/usage-panel/extension.js
 *
 * Extensions extend the UI: they contribute PANELS (rendered in the TUI via
 * the tab cycle and in the mobile web app as extra tabs) and commands.
 * Panels render to plain text/markdown — perfect for monochrome UIs and
 * guaranteed to work on mobile.
 *
 * Shape: { name, version, description, setup(ctx), contributions: { commands, panels } }
 */
export default {
  name: "usage-panel",
  version: "1.0.0",
  description: "Session usage panel",

  setup(ctx) {
    ctx.log("info", "usage-panel loaded");
  },

  contributions: {
    commands: [
      {
        name: "usage",
        description: "Show session usage stats",
        run(args, uiCtx) {
          const h = uiCtx.harness;
          return [
            `model:    ${h.model}`,
            `provider: ${h.config.provider}`,
            `tokens:   ~${h.session.estimateTokens()}`,
            `messages: ${h.session.messages.length}`,
            `tools:    ${h.tools.list().length}`,
          ].join("\n");
        },
      },
    ],
    panels: [
      {
        id: "usage",
        title: "Usage",
        render(uiCtx) {
          const h = uiCtx.harness;
          return [
            "── NOIR usage ─────────────",
            `provider : ${h.config.provider}`,
            `model    : ${h.model}`,
            `tokens   : ~${h.session.estimateTokens()} / ${h.config.compactAtTokens} (compaction threshold)`,
            `messages : ${h.session.messages.length}`,
            `tools    : ${h.tools.list().length} registered`,
            `skills   : ${h.skills.list().length} loaded`,
            `mcp      : ${h.mcp.listServers().length} servers`,
            "",
            "memory workspace:",
            `  ${h.memory.dir}`,
          ].join("\n");
        },
      },
    ],
  },
};
