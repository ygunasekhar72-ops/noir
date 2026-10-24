import type { Config } from "../config.js";
import { duckduckgoSearch } from "./duckduckgo.js";
import { braveSearch, searxngSearch, tavilySearch } from "./providers.js";
import type { SearchResult } from "./types.js";

export type { SearchResult } from "./types.js";

export async function runSearch(config: Config, query: string, maxResults?: number): Promise<SearchResult[]> {
  const max = maxResults ?? config.search.maxResults ?? 8;
  const p = config.search.provider;
  try {
    if (p === "brave") {
      const key = config.search.braveKey || process.env.BRAVE_API_KEY;
      if (!key) throw new Error("Brave provider selected but no braveKey configured (config.search.braveKey).");
      return await braveSearch(query, key, max);
    }
    if (p === "tavily") {
      const key = config.search.tavilyKey || process.env.TAVILY_API_KEY;
      if (!key) throw new Error("Tavily provider selected but no tavilyKey configured (config.search.tavilyKey).");
      return await tavilySearch(query, key, max);
    }
    if (p === "searxng") {
      if (!config.search.searxUrl) throw new Error("searxng provider selected but no searxUrl configured.");
      return await searxngSearch(query, config.search.searxUrl, max);
    }
    return await duckduckgoSearch(query, max);
  } catch (err) {
    // graceful fallback: if the configured API provider fails, try keyless DuckDuckGo
    if (p !== "duckduckgo") {
      try {
        return await duckduckgoSearch(query, max);
      } catch {
        /* fall through to original error */
      }
    }
    throw err;
  }
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}
