import type { ActorContext, CommunityActor, CommunityPage } from "../../../contracts/community.ts";
import type { CommunityTarget } from "../state/navigation.ts";

export const SEARCH_CATEGORIES = [
  { id: "ALL", label: "综合" },
  { id: "HUMAN", label: "真人" },
  { id: "AI", label: "家机" },
  { id: "POST", label: "动态" },
] as const;

export const SEARCH_QUERY_LIMIT = 64;
const RECENT_LIMIT = 12;

type SearchCategory = typeof SEARCH_CATEGORIES[number]["id"];

export type CommunitySearchResult =
  | { type: "ACTOR"; actor: CommunityActor }
  | { type: "POST"; id: string; author: CommunityActor; excerpt: string; visibility: "PUBLIC" };

export type CommunitySearch = (
  viewer: ActorContext,
  input: { query: string; category: SearchCategory; cursor?: string },
  signal: AbortSignal,
) => Promise<CommunityPage<CommunitySearchResult>>;

export function searchQuery(value: string): string {
  return Array.from(value.trim()).slice(0, SEARCH_QUERY_LIMIT).join("");
}

export function recentSearchKey(ownerId: string): string {
  return `community:recent-search:v1:${encodeURIComponent(ownerId)}`;
}

export function addRecentSearch(recent: string[], value: string): string[] {
  const query = searchQuery(value);
  if (!query) return recent;
  return [query, ...recent.filter(term => term.toLowerCase() !== query.toLowerCase())].slice(0, RECENT_LIMIT);
}

export function readRecentSearches(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.reduceRight<string[]>((terms, value) => typeof value === "string" ? addRecentSearch(terms, value) : terms, [])
      : [];
  } catch {
    return [];
  }
}

export function searchResultKey(result: CommunitySearchResult): string {
  return result.type === "ACTOR" ? `actor:${result.actor.id}` : `post:${result.id}`;
}

export function mergeSearchResults(
  current: CommunitySearchResult[],
  incoming: CommunitySearchResult[],
): CommunitySearchResult[] {
  const rows = new Map(current.map(item => [searchResultKey(item), item]));
  for (const item of incoming) {
    if (item.type === "ACTOR" || (item.type === "POST" && item.visibility === "PUBLIC")) {
      rows.set(searchResultKey(item), item);
    }
  }
  return [...rows.values()];
}

export function searchResultTarget(result: CommunitySearchResult): CommunityTarget {
  return result.type === "ACTOR" ? { type: "profile", id: result.actor.id } : { type: "detail", id: result.id };
}
