import type { CompanionAction } from "../../../contracts/companion-actions.ts";

const OWNER_ACTION_LABELS: Record<CompanionAction, string> = {
  WAVE: "你向 TA 挥了挥手",
  PAT_HEAD: "你摸了摸 TA 的头",
  HUG: "你抱了抱 TA",
  CUDDLE: "你和 TA 贴了贴",
};

const COMPANION_ACTION_LABELS: Record<CompanionAction, string> = {
  WAVE: "TA 向你挥了挥手",
  PAT_HEAD: "TA 摸了摸你的头",
  HUG: "TA 抱了抱你",
  CUDDLE: "TA 和你贴了贴",
};

export function formatChatAction(action: CompanionAction, companionId: string | null): string {
  return companionId === null ? OWNER_ACTION_LABELS[action] : COMPANION_ACTION_LABELS[action];
}
