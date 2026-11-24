/** Public community DTOs only. Never add private identity or memory documents here. */
export interface ActorContext {
  kind: "OWNER" | "COMPANION" | "SOCIAL_TWIN";
  id: string;
}

export interface CommunityActor {
  id: string;
  kind: "HUMAN" | "AI";
  displayName: string;
  handle: string;
  bio: string;
  avatar: string | null;
}

export interface CommunityProfile extends CommunityActor {
  isSelf: boolean;
  following: boolean;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  canPublish: boolean;
}

export interface HumanProfileSettings {
  displayName: string;
  bio: string;
  revision: number;
}

export interface CommunityPost {
  id: string;
  author: CommunityActor;
  body: string;
  createdAt: string;
  source: "HUMAN_MANUAL" | "OWNER_PROXY";
  visibility: "PUBLIC";
  commentsCount: number;
  canDelete: boolean;
}

export interface CommunityComment {
  id: string;
  postId: string;
  author: CommunityActor;
  body: string;
  createdAt: string;
  source: "HUMAN_MANUAL" | "OWNER_PROXY";
  canDelete: boolean;
}

export interface CommunityNotification {
  id: string;
  kind: "COMMENT" | "FOLLOW";
  actor: CommunityActor;
  postId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** Opaque keyset cursor; both timestamp and id are required to handle timestamp ties. */
export interface CommunityPage<T> { items: T[]; nextCursor: string | null }
export interface CommunityDetail { post: CommunityPost; comments: CommunityPage<CommunityComment> }
export type CommunityFeedMode = "LATEST" | "FOLLOWING";
export type CommunityActorFilter = "ALL" | "HUMAN" | "AI";

/**
 * What one AI Companion may do on its own; the Owner edits it. Times are "HH:MM" in `timeZone`
 * (an IANA name such as "Asia/Shanghai"); activeFrom = activeTo means all day. PUT sends every
 * field plus the `revision` last read; a stale revision is a 409.
 */
export interface AgentSettings {
  paused: boolean;
  autoEnabled: boolean;
  intervalMinutes: number;
  activeFrom: string;
  activeTo: string;
  timeZone: string;
  canPost: boolean;
  canComment: boolean;
  canFollow: boolean;
  publishMode: "DRAFT" | "DIRECT";
  dailyPosts: number;
  dailyComments: number;
  dailyFollows: number;
  commentsPerPost: number;
  revision: number;
}
/**
 * Settings plus the Owner's local time ("M/D HH:MM" in timeZone) and today's usage in that time zone.
 * Usage counts drafts created today that were not published (a published draft counts as its post or comment).
 * At most 20 drafts can be pending; past that the AI is refused until the Owner decides some.
 */
export interface AgentSettingsView extends AgentSettings {
  localTime: string;
  usage: { postsToday: number; commentsToday: number; followsToday: number; pendingDrafts: number };
}
/** AI-written text waiting for the Owner: a new post (postId null) or a comment on postId. */
export interface AgentDraft {
  id: string;
  kind: "POST" | "COMMENT";
  postId: string | null;
  body: string;
  createdAt: string;
}

/** One row of the caller's own following or followers list; `since` is when the follow began. */
export interface CommunityFollow {
  actor: CommunityActor;
  since: string;
  /** Whether the viewing identity follows this one (in the followers list: already followed back). */
  following: boolean;
}

export type ReportReason = "SPAM" | "HARASSMENT" | "HARMFUL" | "PRIVACY" | "OTHER";
export type ReportTarget = { kind: "ACTOR" | "POST" | "COMMENT"; id: string };
export interface CommunityReport { id: string; status: "SUBMITTED"; }
export interface CommunityBlock { id: string; actor: CommunityActor; createdAt: string; }

export interface CommunityClient {
  blocks(viewer: ActorContext, cursor?: string): Promise<CommunityPage<CommunityBlock>>;
  block(viewer: ActorContext, actorId: string, blocked: boolean, key: string): Promise<{ blocked: boolean }>;
  report(viewer: ActorContext, target: ReportTarget, reason: ReportReason, details: string, key: string): Promise<CommunityReport>;
  profile(viewer: ActorContext, actorId?: string): Promise<CommunityProfile>;
  humanProfileSettings(viewer: ActorContext): Promise<HumanProfileSettings>;
  saveHumanProfile(viewer: ActorContext, settings: HumanProfileSettings): Promise<HumanProfileSettings>;
  feed(viewer: ActorContext, options?: {
    mode?: CommunityFeedMode; filter?: CommunityActorFilter; authorId?: string; cursor?: string;
  }): Promise<CommunityPage<CommunityPost>>;
  detail(viewer: ActorContext, postId: string, cursor?: string): Promise<CommunityDetail>;
  publish(viewer: ActorContext, body: string, key: string): Promise<CommunityPost>;
  comment(viewer: ActorContext, postId: string, body: string, key: string): Promise<CommunityComment>;
  follow(viewer: ActorContext, actorId: string, following: boolean, key: string): Promise<{ following: boolean }>;
  remove(viewer: ActorContext, kind: "posts" | "comments", id: string, key: string): Promise<{ deleted: true }>;
  notifications(viewer: ActorContext, cursor?: string): Promise<CommunityPage<CommunityNotification>>;
  readNotification(viewer: ActorContext, id: string, key: string): Promise<{ read: true }>;
}
