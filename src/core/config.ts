import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** ------------------------------------------------------------------ *
 * Config model
 * ------------------------------------------------------------------ */

export interface McpServerConfig {
  transport?: "stdio" | "http";
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

export interface Config {
  version: number;
  /** provider preset id: openai, anthropic, google, groq, openrouter, deepseek, mistral, together, xai, ollama, lmstudio, custom, mock */
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** auto-compact when estimated session tokens exceed this */
  compactAtTokens: number;
  /** max agent loop iterations per turn */
  maxSteps: number;
  shellTimeoutMs: number;
  toolOutputLimit: number;
  search: {
    provider: "duckduckgo" | "brave" | "tavily" | "searxng";
    braveKey?: string;
    tavilyKey?: string;
    searxUrl?: string;
    maxResults?: number;
  };
  mcpServers: Record<string, McpServerConfig>;
  server: {
    host: string;
    port: number;
    token?: string;
    /** "auto" = token required only when bound to a non-loopback host */
    auth: boolean | "auto";
  };
  logging: { level: "debug" | "info" | "warn" | "error" | "silent" };
  /** per-provider overrides: apiKey / baseUrl / model */
  providers?: Record<string, { apiKey?: string; baseUrl?: string; model?: string }>;
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  provider: "openai",
  model: "gpt-4o-mini",
  temperature: 0.4,
  maxTokens: 8192,
  compactAtTokens: 60000,
  maxSteps: 60,
  shellTimeoutMs: 120000,
  toolOutputLimit: 60000,
  search: {
    provider: "duckduckgo",
    braveKey: "",
    tavilyKey: "",
    searxUrl: "",
    maxResults: 8,
  },
  mcpServers: {},
  server: { host: "127.0.0.1", port: 5178, auth: "auto" },
  logging: { level: "info" },
  providers: {},
};

/** env var candidates per provider, first found wins */
export const ENV_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  xai: ["XAI_API_KEY"],
  ollama: [],
  lmstudio: [],
  custom: [],
  mock: [],
};

/** ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

export function globalDir(): string {
  return process.env.NOIR_HOME ? resolve(process.env.NOIR_HOME) : join(homedir(), ".noir");
}

export function projectNoirDir(projectDir: string): string {
  return join(projectDir, ".noir");
}

export function projectMemoryDir(projectDir: string): string {
  return join(projectDir, ".noir", "memory");
}

export function projectSessionsDir(projectDir: string): string {
  return join(projectDir, ".noir", "sessions");
}

export function globalMemoryDir(): string {
  return join(globalDir(), "memory");
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Root of the installed noir-harness package (walks up from this compiled file). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const probe = join(dir, "package.json");
    if (existsSync(probe)) {
      try {
        const pkg = JSON.parse(readFileSync(probe, "utf8"));
        if (pkg && typeof pkg.name === "string" && pkg.name.includes("noir")) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: dist/core/config.js -> package root is two levels up
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** ------------------------------------------------------------------ *
 * Merge & load
 * ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge plain objects; arrays and scalars replace. Never mutates base. */
export function deepMerge<T>(base: T, over: Partial<T> | undefined | null): T {
  const b = base as Record<string, unknown>;
  const o = (over ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(b[k])) out[k] = deepMerge(b[k], v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(data) ? data : null;
  } catch {
    return null;
  }
}

export interface LoadedConfig {
  config: Config;
  globalPath: string;
  projectPath: string | null;
  sources: string[];
}

/**
 * Load order: defaults <- global (~/.noir/config.json) <- project (.noir/config.json)
 * <- env overrides (NOIR_PROVIDER, NOIR_MODEL, NOIR_API_KEY, provider env keys).
 */
export function loadConfig(projectDir: string): LoadedConfig {
  const globalPath = join(globalDir(), "config.json");
  const projectPath = join(projectNoirDir(projectDir), "config.json");
  const sources: string[] = [];

  const g = readJsonIfExists(globalPath);
  const p = existsSync(projectPath) ? readJsonIfExists(projectPath) : null;

  let config: Config = DEFAULT_CONFIG;
  if (g) {
    config = deepMerge(config, g as Partial<Config>);
    sources.push(globalPath);
  }
  if (p) {
    config = deepMerge(config, p as Partial<Config>);
    sources.push(projectPath);
  }

  // env overrides
  if (process.env.NOIR_PROVIDER) config.provider = process.env.NOIR_PROVIDER;
  if (process.env.NOIR_MODEL) config.model = process.env.NOIR_MODEL;
  if (process.env.NOIR_API_KEY) config.apiKey = process.env.NOIR_API_KEY;
  if (process.env.NOIR_COMPACT_AT_TOKENS) {
    const n = parseInt(process.env.NOIR_COMPACT_AT_TOKENS, 10);
    if (Number.isFinite(n) && n > 0) config.compactAtTokens = n;
  }
  const envKey = firstEnvKey(config.provider);
  if (envKey && !config.apiKey) config.apiKey = envKey;

  return { config, globalPath, projectPath: p ? projectPath : null, sources };
}

export function firstEnvKey(providerId: string): string | undefined {
  const keys = ENV_KEYS[providerId];
  if (keys) for (const k of keys) if (process.env[k]) return process.env[k] as string;
  return undefined;
}

/** Resolve the API key for a provider: config.providers override -> generic -> env. */
export function resolveApiKey(config: Config, providerId: string): string | undefined {
  const o = config.providers?.[providerId];
  if (o?.apiKey) return o.apiKey;
  if (config.apiKey && providerId === config.provider) return config.apiKey;
  return firstEnvKey(providerId) ?? undefined;
}

export function saveGlobalConfig(config: Config): string {
  ensureDir(globalDir());
  const path = join(globalDir(), "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

export function saveProjectConfig(projectDir: string, config: Config): string {
  ensureDir(projectNoirDir(projectDir));
  const path = join(projectNoirDir(projectDir), "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

export function writeSampleConfig(projectDir: string, target: "project" | "global"): string {
  const cfg: Partial<Config> = {
    provider: "openai",
    model: "gpt-4o-mini",
    search: { provider: "duckduckgo" },
    mcpServers: {
      filesystem: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      },
    },
  };
  return target === "global"
    ? saveGlobalConfig(deepMerge(DEFAULT_CONFIG, cfg as Partial<Config>))
    : saveProjectConfig(projectDir, deepMerge(DEFAULT_CONFIG, cfg as Partial<Config>));
}
