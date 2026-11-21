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

export interface CommunityClient {
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
