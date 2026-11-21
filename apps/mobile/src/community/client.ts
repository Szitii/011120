import type { ActorContext, CommunityClient, CommunityFeedMode, CommunityActorFilter } from "../../../../packages/community-contracts/types.ts";

type Requester = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, key?: string) => Promise<T>;

export function createCommunityClient(request: Requester): CommunityClient {
  const path = (viewer: ActorContext, resource: string, extra: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams({ actorKind: viewer.kind, actorId: viewer.id });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, v);
    return `/v0/community/${resource}?${params}`;
  };
  return {
    profile: (v, actorId) => request("GET", path(v, actorId ? `profile/${encodeURIComponent(actorId)}` : "profile")),
    feed: (v, options: { mode?: CommunityFeedMode; filter?: CommunityActorFilter; authorId?: string; cursor?: string } = {}) =>
      request("GET", path(v, "feed", options)),
    detail: (v, postId, cursor) => request("GET", path(v, `posts/${encodeURIComponent(postId)}`, { cursor })),
    publish: (v, body, key) => request("POST", path(v, "posts"), { body }, key),
    comment: (v, postId, body, key) => request("POST", path(v, `posts/${encodeURIComponent(postId)}/comments`), { body }, key),
    follow: (v, actorId, following, key) => request(following ? "PUT" : "DELETE", path(v, `following/${encodeURIComponent(actorId)}`), undefined, key),
    remove: (v, kind, id, key) => request("DELETE", path(v, `${kind}/${encodeURIComponent(id)}`), undefined, key),
    notifications: (v, cursor) => request("GET", path(v, "notifications", { cursor })),
    readNotification: (v, id, key) => request("PUT", path(v, `notifications/${encodeURIComponent(id)}/read`), undefined, key),
  };
}

export function communityRequestKey(): string {
  return `community-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
