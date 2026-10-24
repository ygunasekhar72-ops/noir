import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { errResult, schema, textResult, type Tool } from "./types.js";

export interface ShellRunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutput?: number;
  onOutput?: (chunk: string) => void;
  background?: boolean;
  logPath?: string;
}

export interface ShellRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  signal?: string;
}

/** Core shell executor used by the agent tool, the TUI terminal and the web app terminal. */
export function runShell(command: string, opts: ShellRunOptions): Promise<ShellRunResult> {
  const maxOutput = opts.maxOutput ?? 200_000;
  return new Promise((resolve) => {
    let output = "";
    let truncated = false;
    const append = (s: string) => {
      if (output.length >= maxOutput) {
        truncated = true;
        return;
      }
      output += s;
      if (output.length > maxOutput) {
        output = output.slice(0, maxOutput);
        truncated = true;
      }
      opts.onOutput?.(s);
    };

    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: process.env,
    });

    let timedOut = false;
    const timer = opts.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }, opts.timeoutMs) : null;

    if (opts.background) {
      // detach: redirect output to a log file the agent can poll
      clearTimeout(timer!);
      const logPath = opts.logPath ?? join(opts.cwd, ".noir", "tmp", `bg-${child.pid ?? Date.now()}.log`);
      mkdirSync(join(logPath, ".."), { recursive: true });
      resolve({ output: `Started in background (pid ${child.pid}). Output log: ${logPath}`, exitCode: 0, timedOut: false });
      child.unref();
      return;
    }

    child.stdout?.on("data", (d: Buffer) => append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => append(d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ output: `spawn error: ${err.message}`, exitCode: -1, timedOut });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (truncated) output += `\n…(output truncated at ${maxOutput} bytes)`;
      resolve({ output, exitCode: code, timedOut, signal: signal ?? undefined });
    });
  });
}

export const shellTools: Tool[] = [
  {
    name: "run_command",
    description:
      "Run a shell command in the project directory and return combined stdout/stderr with the exit code. Use for builds, tests, git, package managers, etc. Long builds: raise timeoutMs or set background=true and poll the printed log file by reading it.",
    parameters: schema.obj({
      command: schema.str("Shell command to run"),
      timeoutMs: schema.num("Timeout in milliseconds (default from config, max 600000)"),
      background: schema.bool("Run detached; returns immediately with a log file path"),
    }, ["command"]),
    run(args, ctx) {
      const command = String(args.command ?? "");
      if (!command.trim()) return errResult("command must not be empty");
      const timeoutMs = Math.min(Number(args.timeoutMs ?? ctx.config.shellTimeoutMs ?? 120000), 600000);
      return runShell(command, {
        cwd: ctx.cwd,
        timeoutMs,
        background: args.background === true,
      }).then((r) =>
        textResult(
          `$ ${command}\n${r.output}\n${r.exitCode === 0 && !r.timedOut ? "[exit 0]" : `[exit ${r.exitCode ?? "signal"}${r.timedOut ? " (timed out)" : ""}]`}`
        )
      );
    },
  },
];
