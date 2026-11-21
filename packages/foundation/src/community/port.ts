import type { ActorContext, HumanProfileSettings } from "../../../community-contracts/types.ts";

export interface CommunityRead {
  actor: ActorContext;
  resource: "profile" | "feed" | "detail" | "notifications";
  targetId: string | null;
  mode: "LATEST" | "FOLLOWING";
  filter: "ALL" | "HUMAN" | "AI";
  beforeAt: string | null;
  beforeId: string | null;
}

export interface CommunityCommand {
  actor: ActorContext;
  action: "POST" | "COMMENT" | "FOLLOW" | "UNFOLLOW" | "DELETE_POST" | "DELETE_COMMENT" | "READ_NOTIFICATION";
  targetId: string | null;
  body: string | null;
  keyHash: string;
  requestHash: string;
}

export interface CommunityPort {
  read(input: CommunityRead): Promise<unknown>;
  command(input: CommunityCommand): Promise<unknown>;
  humanProfileSettings(actor: ActorContext): Promise<unknown>;
  saveHumanProfile(actor: ActorContext, settings: HumanProfileSettings): Promise<unknown>;
}
