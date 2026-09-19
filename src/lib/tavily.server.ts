import type { SearchResult } from "./live-planner.ts";

export const DEFAULT_TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export function normalizeTavilyResults(raw: unknown): SearchResult[] {
  if (!raw || typeof raw !== "object" || !("results" in raw)) return [];
  const rows = (raw as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.title !== "string" || typeof row.url !== "string") return [];
    const url = row.url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return [];
    return [
      {
        title: row.title.trim(),
        url,
        content: typeof row.content === "string" ? row.content.trim() : "",
        score: typeof row.score === "number" ? row.score : undefined,
      },
    ];
  });
}

export async function searchTavily(
  apiKey: string,
  query: string,
  endpoint = DEFAULT_TAVILY_SEARCH_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`景区搜索失败（${response.status}）`);
  }

  return normalizeTavilyResults(await response.json());
}

export function dedupeSources(sources: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}
