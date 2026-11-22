import type { ActorContext, AgentSettings, HumanProfileSettings } from "../../../contracts/community.ts";

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
  keyHash: string;
  requestHash: string;
}

/** A post or comment the AI writes; subject to the Companion's agent settings. */
export type AgentCommand = CommunityCommand & { action: "POST" | "COMMENT" };

export interface CommunityPort {
  read(input: CommunityRead): Promise<unknown>;
  command(input: CommunityCommand): Promise<unknown>;
  humanProfileSettings(actor: ActorContext): Promise<unknown>;
  saveHumanProfile(actor: ActorContext, settings: HumanProfileSettings): Promise<unknown>;
  agentSettings(actor: ActorContext): Promise<unknown>;
  saveAgentSettings(actor: ActorContext, settings: AgentSettings): Promise<unknown>;
  agentCommand(input: AgentCommand): Promise<unknown>;
  agentDrafts(actor: ActorContext): Promise<unknown>;
  decideAgentDraft(actor: ActorContext, draftId: string, publish: boolean): Promise<unknown>;
}
