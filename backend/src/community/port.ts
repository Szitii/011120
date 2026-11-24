import type { ActorContext, AgentSettings, HumanProfileSettings, PostVisibility } from "../../../contracts/community.ts";

export interface CommunityRead {
  actor: ActorContext;
  resource: "profile" | "feed" | "detail" | "notifications" | "blocks";
  targetId: string | null;
  mode: "LATEST" | "FOLLOWING";
  filter: "ALL" | "HUMAN" | "AI";
  beforeAt: string | null;
  beforeId: string | null;
}

export interface CommunityCommand {
  actor: ActorContext;
  action: "POST" | "COMMENT" | "FOLLOW" | "UNFOLLOW" | "DELETE_POST" | "DELETE_COMMENT" | "READ_NOTIFICATION" | "BLOCK" | "UNBLOCK" | "REPORT_ACTOR" | "REPORT_POST" | "REPORT_COMMENT";
  targetId: string | null;
  body: string | null;
  /** POST only: who can see it; left out means PUBLIC. */
  visibility?: PostVisibility;
  /** POST and COMMENT: the identities named in the text (at most 10). */
  mentions?: string[];
  keyHash: string;
  requestHash: string;
}

/** Something the AI does as its Companion; subject to the Owner's agent settings. */
export type AgentCommand = CommunityCommand & { action: "POST" | "COMMENT" | "FOLLOW" | "UNFOLLOW" };

export interface FollowList {
  actor: ActorContext;
  direction: "FOLLOWING" | "FOLLOWERS";
  beforeAt: string | null;
  beforeId: string | null;
}

export interface CommunityPort {
  read(input: CommunityRead): Promise<unknown>;
  followList(input: FollowList): Promise<unknown>;
  command(input: CommunityCommand): Promise<unknown>;
  /** Like a post or take the like back; { liked, likeCount }. */
  like(actor: ActorContext, postId: string, liked: boolean): Promise<unknown>;
  humanProfileSettings(actor: ActorContext): Promise<unknown>;
  saveHumanProfile(actor: ActorContext, settings: HumanProfileSettings): Promise<unknown>;
  agentSettings(actor: ActorContext): Promise<unknown>;
  saveAgentSettings(actor: ActorContext, settings: AgentSettings): Promise<unknown>;
  agentCommand(input: AgentCommand): Promise<unknown>;
  agentDrafts(actor: ActorContext): Promise<unknown>;
  decideAgentDraft(actor: ActorContext, draftId: string, publish: boolean): Promise<unknown>;
}
