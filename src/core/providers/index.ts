import type { Config } from "../config.js";
import { resolveApiKey } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { AIProvider } from "./types.js";

export * from "./types.js";
export { MockProvider } from "./mock.js";

export interface ProviderPreset {
  label: string;
  kind: "openai" | "anthropic" | "google" | "mock";
  baseUrl: string;
  models: string[];
  needsKey: boolean;
  hint?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"],
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-3-5-haiku-latest"],
    needsKey: true,
  },
  google: {
    label: "Google Gemini",
    kind: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    needsKey: true,
  },
  groq: {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash", "meta-llama/llama-3.3-70b-instruct"],
    needsKey: true,
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
  },
  mistral: {
    label: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"],
    needsKey: true,
  },
  together: {
    label: "Together",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    needsKey: true,
  },
  xai: {
    label: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-3", "grok-3-mini"],
    needsKey: true,
  },
  ollama: {
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["llama3.2", "qwen2.5", "mistral", "phi4"],
    needsKey: false,
  },
  lmstudio: {
    label: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["local-model"],
    needsKey: false,
  },
  mock: {
    label: "Mock (offline)",
    kind: "mock",
    baseUrl: "",
    models: ["mock"],
    needsKey: false,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "",
    models: [],
    needsKey: false,
    hint: "set baseUrl",
  },
};

export function createProvider(id: string, config: Config): AIProvider {
  const preset = PROVIDER_PRESETS[id] ?? PROVIDER_PRESETS.custom;
  const override = config.providers?.[id];
  const apiKey = resolveApiKey(config, id);
  const baseUrl = override?.baseUrl ?? config.baseUrl ?? preset.baseUrl;

  if (!baseUrl && preset.kind === "openai") {
    throw new Error(`Provider "${id}" needs a baseUrl. Set "baseUrl" in config or use a preset like openai, groq, ollama...`);
  }
  if (preset.needsKey && !apiKey) {
    throw new Error(
      `Provider "${id}" needs an API key. Set ${id.toUpperCase()}_API_KEY env var, or "apiKey" in config, or config.providers.${id}.apiKey.`
    );
  }

  switch (preset.kind) {
    case "anthropic":
      return new AnthropicProvider({ baseUrl, apiKey });
    case "google":
      return new GoogleProvider({ baseUrl, apiKey });
    case "mock":
      return new MockProvider();
    default:
      return new OpenAICompatibleProvider(id, preset.label, baseUrl, apiKey);
  }
}

/** Resolve the effective base URL for a provider id (used by `noir models` output). */
export function providerEndpoint(id: string, config: Config): { label: string; baseUrl: string; models: string[] } {
  const preset = PROVIDER_PRESETS[id] ?? PROVIDER_PRESETS.custom;
  const override = config.providers?.[id];
  return {
    label: preset.label,
    baseUrl: override?.baseUrl ?? config.baseUrl ?? preset.baseUrl,
    models: override?.model ? [override.model, ...preset.models] : preset.models,
  };
}

/** One-shot, tool-free text completion utility (used by compaction + swarm planning). */
export async function completeText(
  provider: AIProvider,
  model: string,
  prompt: string,
  opts: { system?: string; maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const messages = [...(opts.system ? [{ role: "system" as const, content: opts.system }] : []), { role: "user" as const, content: prompt }];
  let out = "";
  for await (const ev of provider.stream({ messages, tools: [], model, ...opts })) {
    if (ev.type === "text") out += ev.text;
  }
  return out.trim();
}
