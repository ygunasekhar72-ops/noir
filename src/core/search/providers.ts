import type { SearchResult } from "./types.js";

export async function braveSearch(query: string, key: string, maxResults = 8): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`Brave Search API error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const j = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
  const out = (j.web?.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
  }));
  if (!out.length) throw new Error("Brave Search returned no results.");
  return out;
}

export async function tavilySearch(query: string, key: string, maxResults = 8): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, search_depth: "basic" }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Tavily API error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  const out = (j.results ?? []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 400) }));
  if (!out.length) throw new Error("Tavily returned no results.");
  return out;
}

export async function searxngSearch(query: string, baseUrl: string, maxResults = 8): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`SearxNG error ${res.status}`);
  const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  const out = (j.results ?? []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 400) }));
  if (!out.length) throw new Error("SearxNG returned no results.");
  return out;
}
