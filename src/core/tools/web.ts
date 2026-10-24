import { errResult, schema, textResult, type Tool } from "./types.js";
import { runSearch, formatSearchResults } from "../search/index.js";
import { stripTags, USER_AGENT } from "../search/types.js";

export async function fetchUrl(
  url: string,
  opts: { maxChars?: number } = {}
): Promise<{ status: number; contentType: string; text: string; finalUrl: string }> {
  const maxChars = opts.maxChars ?? 24000;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  let text: string;
  if (contentType.includes("html")) {
    text = stripTags(raw)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = raw;
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n…(truncated at ${maxChars} chars)`;
  return { status: res.status, contentType, text, finalUrl: res.url || url };
}

export const webTools: Tool[] = [
  {
    name: "web_search",
    description: "Search the web. Returns ranked results with titles, URLs and snippets.",
    parameters: schema.obj({
      query: schema.str("Search query"),
      maxResults: schema.num("Max results (default 8)"),
    }, ["query"]),
    readOnly: true,
    run(args, ctx) {
      const query = String(args.query ?? "").trim();
      if (!query) return errResult("query is required");
      return runSearch(ctx.config, query, Number(args.maxResults ?? undefined))
        .then((results) => textResult(formatSearchResults(results)))
        .catch((err) => errResult(`web_search failed: ${(err as Error).message}`));
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return readable text (HTML is stripped to plain text). Use for reading pages, APIs and docs.",
    parameters: schema.obj({
      url: schema.str("URL to fetch"),
    }, ["url"]),
    readOnly: true,
    run(args) {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return errResult("url must start with http:// or https://");
      return fetchUrl(url)
        .then((r) => textResult(`URL: ${r.finalUrl}\nStatus: ${r.status}\n\n${r.text}`))
        .catch((err) => errResult(`web_fetch failed: ${(err as Error).message}`));
    },
  },
];
