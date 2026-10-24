import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { globalDir } from "../config.js";
import type { Logger } from "../logger.js";
import type { ToolDef } from "../providers/types.js";

/** Shared context handed to plugin/extension setup(). */
export interface HostContext {
  harness: {
    /** Register an agent tool. */
    registerTool(tool: ToolDef & { run(args: Record<string, unknown>): Promise<string> | string }): void;
    /** Register a slash command: run(args: string[], ctx) -> string */
    registerCommand(cmd: { name: string; description: string; run: (args: string[], ctx: unknown) => Promise<string> | string }): void;
    /** Register a UI panel (rendered in TUI + mobile web app). */
    registerPanel(panel: { id: string; title: string; render: (ctx: unknown) => Promise<string> | string }): void;
    on(event: string, listener: (payload: unknown) => void): void;
    /** read/write project config values */
    getConfig(): Record<string, unknown>;
    log(level: "debug" | "info" | "warn" | "error", msg: string): void;
    projectDir: string;
    version: string;
  };
}

export interface LoadedModule {
  kind: "plugin" | "extension";
  name: string;
  path: string;
  version: string;
  description: string;
  module: Record<string, unknown>;
  error?: string;
}

function isPluginShape(mod: any): boolean {
  return mod && (typeof mod.setup === "function" || typeof mod.default?.setup === "function");
}

/** CJS interop: handles export default / module.exports / named setup. */
function normalize(mod: any): any {
  if (mod?.default) mod = { ...mod.default, ...mod, default: mod.default };
  if (typeof mod === "function") mod = { setup: mod };
  return mod;
}

/** Base loader for both plugins and extensions (they share the module shape). */
export class ModuleLoader {
  constructor(
    private projectDir: string,
    private kind: "plugin" | "extension",
    private logger: Logger
  ) {}

  /** Load all modules from project + global dirs. Returns loaded module records. */
  async loadAll(): Promise<LoadedModule[]> {
    const dirs = [join(this.projectDir, ".noir", this.kind === "plugin" ? "plugins" : "extensions"), join(globalDir(), this.kind === "plugin" ? "plugins" : "extensions")];
    const out: LoadedModule[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = resolve(dir, entry);
        try {
          if (!statSync(full).isDirectory()) {
            if (/\.(mjs|cjs|js)$/.test(entry)) out.push(await this.loadFile(full, entry));
          } else {
            // npm-style package dir: package.json main, index.js, plugin.js, extension.js
            const pkgPath = join(full, "package.json");
            let target: string | null = null;
            let pkgMeta: any = undefined;
            if (existsSync(pkgPath)) {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
              pkgMeta = pkg;
              target = join(full, pkg.main ?? "index.js");
            }
            if (!target || !existsSync(target)) {
              for (const cand of ["index.js", "index.mjs", "index.cjs", "plugin.js", "plugin.mjs", "plugin.cjs", "extension.js", "extension.mjs", "extension.cjs", `${this.kind}.js`, `${this.kind}.mjs`, `${this.kind}.cjs`]) {
                if (existsSync(join(full, cand))) {
                  target = join(full, cand);
                  break;
                }
              }
            }
            if (target) out.push(await this.loadFile(target, entry, pkgMeta));
          }
        } catch (err) {
          out.push({
            kind: this.kind,
            name: entry,
            path: full,
            version: "?",
            description: "",
            module: {},
            error: (err as Error).message,
          });
          this.logger.warn(`${this.kind} "${entry}" failed to load: ${(err as Error).message}`);
        }
      }
    }
    return out;
  }

  private async loadFile(path: string, fallbackName: string, pkg?: any): Promise<LoadedModule> {
    let mod: any;
    if (path.endsWith(".cjs")) {
      const req = createRequire(import.meta.url);
      mod = req(path);
    } else {
      mod = await import(pathToFileURL(path).href);
    }
    mod = normalize(mod);
    if (!isPluginShape(mod) && !(mod?.contributions && typeof mod.contributions === "object")) {
      throw new Error("module must export setup(ctx) and/or contributions");
    }
    return {
      kind: this.kind,
      name: mod.name ?? pkg?.name ?? fallbackName.replace(/\.(mjs|cjs|js)$/, ""),
      path,
      version: mod.version ?? pkg?.version ?? "0.0.0",
      description: mod.description ?? pkg?.description ?? "",
      module: mod,
    };
  }

  /** Call setup(ctx) on a module if present. Async setups are awaited. */
  async setup(mod: LoadedModule, ctx: HostContext["harness"]): Promise<void> {
    const m = mod.module as any;
    if (typeof m.setup === "function") {
      try {
        await m.setup(ctx);
      } catch (err) {
        mod.error = (err as Error).message;
        this.logger.error(`${mod.kind} "${mod.name}" setup failed: ${(err as Error).message}`);
      }
    }
  }
}
