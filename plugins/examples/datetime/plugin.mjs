/**
 * NOIR plugin example: "datetime"
 * Copy to <project>/.noir/plugins/datetime/plugin.js
 *
 * A plugin extends the HARNESS: it registers tools, commands and event hooks.
 * setup(ctx) is awaited at startup. ctx has:
 *   registerTool({ name, description, parameters, readOnly?, run(args) })
 *   registerCommand({ name, description, run(args, uiCtx) })
 *   on(event, listener)   — agent:start, tool:end, compaction, swarm, ...
 *   getConfig(), log(level, msg), projectDir, version
 */
export default {
  name: "datetime",
  version: "1.0.0",
  description: "Adds a current_time tool and a /time command.",

  setup(ctx) {
    const now = () => new Date().toISOString();

    ctx.registerTool({
      name: "current_time",
      description: "Get the current UTC time (ISO-8601). Use before generating timestamps.",
      parameters: {
        type: "object",
        properties: {},
      },
      run() {
        return `Current UTC time: ${now()}`;
      },
    });

    ctx.registerCommand({
      name: "time",
      description: "Show the current time",
      run() {
        return `UTC: ${now()}`;
      },
    });

    let turns = 0;
    ctx.on("agent:start", () => {
      turns++;
      if (turns % 5 === 0) ctx.log("info", `[datetime] ${turns} turns so far in this session`);
    });
  },
};
