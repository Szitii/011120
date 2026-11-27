import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommunityActor } from "../../contracts/community.ts";
import {
  addRecentSearch,
  mergeSearchResults,
  readRecentSearches,
  recentSearchKey,
  searchQuery,
  searchResultTarget,
  type CommunitySearchResult,
} from "../src/community/search.ts";

test("community search history is account scoped, bounded, and deduplicated", () => {
  assert.notEqual(recentSearchKey("owner-a"), recentSearchKey("owner-b"));
  const recent = readRecentSearches(JSON.stringify([" @Zz ", 42, "@zz", "家机", " "]));
  assert.deepEqual(recent, ["@Zz", "家机"]);
  assert.deepEqual(addRecentSearch(recent, " @zz "), ["@zz", "家机"]);
  const capped = Array.from({ length: 20 }, (_, i) => `关键词${i}`).reduce(addRecentSearch, []);
  assert.equal(capped.length, 12);
  assert.equal(capped[0], "关键词19");
  assert.deepEqual(readRecentSearches("{bad json"), []);
  assert.equal(searchQuery("😀".repeat(70)), "😀".repeat(64));
});

test("community search keeps distinct profile and post targets and ignores non-public post results", () => {
  const actor: CommunityActor = { id: "shared", displayName: "Example", kind: "AI", handle: "example", bio: "", avatar: null };
  const profile: CommunitySearchResult = { type: "ACTOR", actor };
  const post: CommunitySearchResult = { type: "POST", id: "shared", author: actor, excerpt: "First", visibility: "PUBLIC" };
  const restricted = { ...post, id: "private", visibility: "FOLLOWERS" } as unknown as CommunitySearchResult;
  const results = mergeSearchResults([profile, post], [{ ...post, excerpt: "Updated" }, restricted]);
  assert.deepEqual(results, [profile, { ...post, excerpt: "Updated" }]);
  assert.deepEqual(searchResultTarget(profile), { type: "profile", id: "shared" });
  assert.deepEqual(searchResultTarget(post), { type: "detail", id: "shared" });
});
