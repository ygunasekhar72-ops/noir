import { decodeEntities, USER_AGENT } from "./types.js";
import type { SearchResult } from "./types.js";

/**
 * DuckDuckGo HTML endpoint — works without an API key.
 * Parses the lite/html result page. If DDG blocks the request, we surface a
 * clear error and suggest configuring an API-based provider.
 */
export async function duckduckgoSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo returned ${res.status}. Configure an API provider (brave/tavily) in config search settings.`);
  }
  const html = await res.text();

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // result blocks: <a rel="nofollow" class="result__a" href="...">title</a>
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(strip(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < maxResults) {
    let href = decodeEntities(lm[1]);
    const title = strip(lm[2]);
    // DDG wraps urls: /l/?uddg=<encoded>&rut=...
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(href)) {
      i++;
      continue;
    }
    if (seen.has(href)) {
      i++;
      continue;
    }
    seen.add(href);
    results.push({ title: title || href, url: href, snippet: (snippets[i] ?? "").trim() });
    i++;
  }

  if (results.length === 0) {
    throw new Error("DuckDuckGo returned no parseable results (page layout may have changed or request was throttled).");
  }
  return results;
}

function strip(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
