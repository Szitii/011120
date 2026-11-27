import type {
  ActorContext,
  AgentDraft,
  AgentSettings,
  AgentSettingsView,
  CommunityComment,
  CommunityFollow,
  CommunityPage,
  CommunityPost,
  CommunityProfile,
  CommunityClient as BaseCommunityClient,
  CommunityFeedMode,
  CommunityActorFilter,
  PostMediaInput,
  PostVisibility,
} from "../../../contracts/community.ts";

export type AgentViewer = ActorContext & { kind: "COMPANION" | "SOCIAL_TWIN" };

export function isAgentViewer(viewer: ActorContext | undefined): viewer is AgentViewer {
  return viewer?.kind === "COMPANION" || viewer?.kind === "SOCIAL_TWIN";
}

export interface CommunityMediaHandlers {
  uploadPostMedia(path: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  deletePostMedia(path: string): Promise<void>;
  postMediaSource(path: string): Promise<{ uri: string; headers: Record<string, string> } | undefined>;
}

export interface CommunityClient extends Omit<BaseCommunityClient, "publish"> {
  publish(
    viewer: ActorContext,
    body: string,
    key: string,
    options?: { visibility?: PostVisibility; mentions?: string[]; media?: PostMediaInput[] },
  ): Promise<CommunityPost>;
  uploadPostMedia?(path: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  deletePostMedia?(path: string): Promise<void>;
  postMediaSource?(path: string): Promise<{ uri: string; headers: Record<string, string> } | undefined>;
  following(viewer: ActorContext, cursor?: string): Promise<CommunityPage<CommunityFollow>>;
  followers(viewer: ActorContext, cursor?: string): Promise<CommunityPage<CommunityFollow>>;
  agentDrafts(viewer: AgentViewer): Promise<{ items: AgentDraft[] }>;
  publishAgentDraft(viewer: AgentViewer, id: string): Promise<{ published: CommunityPost | CommunityComment }>;
  discardAgentDraft(viewer: AgentViewer, id: string): Promise<{ discarded: true }>;
  agentSettings(viewer: AgentViewer): Promise<AgentSettingsView>;
  saveAgentSettings(viewer: AgentViewer, settings: AgentSettings): Promise<AgentSettingsView>;
}

export class InvalidCommunityPayloadError extends Error {
  constructor() { super("Invalid community response."); }
}

function checkedProfile(profile: CommunityProfile): CommunityProfile {
  if (!profile || typeof profile.id !== "string" || typeof profile.displayName !== "string") {
    throw new InvalidCommunityPayloadError();
  }
  return profile;
}

function checkedFeed(page: CommunityPage<CommunityPost>): CommunityPage<CommunityPost> {
  if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string")
      || page.items.some(post => !post || typeof post.id !== "string" || typeof post.body !== "string"
        || typeof post.createdAt !== "string" || typeof post.author?.id !== "string" || typeof post.author.displayName !== "string"
        || (post.media !== undefined && !Array.isArray(post.media)) || (post.mentions !== undefined && !Array.isArray(post.mentions)))) {
    throw new InvalidCommunityPayloadError();
  }
  return page;
}

type Requester = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, key?: string) => Promise<T>;

export function createCommunityClient(request: Requester, media?: CommunityMediaHandlers): CommunityClient {
  const path = (viewer: ActorContext, resource: string, extra: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams({ actorKind: viewer.kind, actorId: viewer.id });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, v);
    return `/v0/community/${resource}?${params}`;
  };
  return {
    ...(media ?? {}),
    following: (v, cursor) => request("GET", path(v, "following", { cursor })),
    followers: (v, cursor) => request("GET", path(v, "followers", { cursor })),
    agentDrafts: v => request("GET", path(v, "agent/drafts")),
    publishAgentDraft: (v, id) => request("POST", path(v, `agent/drafts/${encodeURIComponent(id)}/publish`)),
    discardAgentDraft: (v, id) => request("POST", path(v, `agent/drafts/${encodeURIComponent(id)}/discard`)),
    agentSettings: v => request("GET", path(v, "agent/settings")),
    saveAgentSettings: (v, settings) => request("PUT", path(v, "agent/settings"), settings),
    blocks: (v, cursor) => request("GET", path(v, "blocks", { cursor })),
    block: (v, actorId, blocked, key) => request(blocked ? "PUT" : "DELETE",
      path(v, `blocks/${encodeURIComponent(actorId)}`), undefined, key),
    report: (v, target, reason, details, key) => request("POST",
      path(v, `reports/${{ ACTOR: "actors", POST: "posts", COMMENT: "comments" }[target.kind]}/${encodeURIComponent(target.id)}`),
      { reason, details }, key),
    profile: (v, actorId) => request<CommunityProfile>("GET", path(v, actorId ? `profile/${encodeURIComponent(actorId)}` : "profile")).then(checkedProfile),
    humanProfileSettings: v => request("GET", path(v, "profile/settings")),
    saveHumanProfile: (v, settings) => request("PUT", path(v, "profile/settings"), settings),
    feed: (v, options: { mode?: CommunityFeedMode; filter?: CommunityActorFilter; authorId?: string; cursor?: string } = {}) =>
      request<CommunityPage<CommunityPost>>("GET", path(v, "feed", options)).then(checkedFeed),
    detail: (v, postId, cursor) => request("GET", path(v, `posts/${encodeURIComponent(postId)}`, { cursor })),
    publish: (v, body, key, options) => request("POST", path(v, "posts"), { body, ...options }, key),
    comment: (v, postId, body, key, options) => request("POST", path(v, `posts/${encodeURIComponent(postId)}/comments`), { body, ...options }, key),
    like: (v, postId, liked) => request(liked ? "PUT" : "DELETE", path(v, `posts/${encodeURIComponent(postId)}/like`)),
    follow: (v, actorId, following, key) => request(following ? "PUT" : "DELETE", path(v, `following/${encodeURIComponent(actorId)}`), undefined, key),
    remove: (v, kind, id, key) => request("DELETE", path(v, `${kind}/${encodeURIComponent(id)}`), undefined, key),
    notifications: (v, cursor) => request("GET", path(v, "notifications", { cursor })),
    readNotification: (v, id, key) => request("PUT", path(v, `notifications/${encodeURIComponent(id)}/read`), undefined, key),
  };
}

export function communityRequestKey(): string {
  return `community-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
