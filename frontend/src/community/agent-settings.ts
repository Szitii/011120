import type { AgentSettings, AgentSettingsView } from "../../../contracts/community.ts";

export const agentLimits = [
  ["dailyPosts", "每日发帖", 0, 30, "postsToday"],
  ["dailyComments", "每日评论", 0, 100, "commentsToday"],
  ["dailyFollows", "每日关注", 0, 50, "followsToday"],
  ["commentsPerPost", "每帖评论", 1, 10, null],
] as const;

export const autoInterval = { min: 15, max: 1440 };

type Limit = typeof agentLimits[number][0] | "intervalMinutes";
export type SettingsForm = Omit<AgentSettings, Limit> & Record<Limit, string>;

export function settingsForm(view: AgentSettingsView): SettingsForm {
  const { localTime: _localTime, usage: _usage, ...settings } = view;
  return {
    ...settings,
    intervalMinutes: String(settings.intervalMinutes),
    dailyPosts: String(settings.dailyPosts),
    dailyComments: String(settings.dailyComments),
    dailyFollows: String(settings.dailyFollows),
    commentsPerPost: String(settings.commentsPerPost),
  };
}

export function settingsPayload(form: SettingsForm, deviceZone?: string): AgentSettings | undefined {
  const time = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!time.test(form.activeFrom) || !time.test(form.activeTo)) return undefined;
  const intervalMinutes = Number(form.intervalMinutes);
  if (!/^\d+$/.test(form.intervalMinutes) || intervalMinutes < autoInterval.min || intervalMinutes > autoInterval.max) return undefined;
  if (agentLimits.some(([key, , min, max]) => !/^\d+$/.test(form[key]) || Number(form[key]) < min || Number(form[key]) > max)) {
    return undefined;
  }
  return {
    paused: form.paused,
    autoEnabled: form.autoEnabled,
    intervalMinutes,
    activeFrom: form.activeFrom,
    activeTo: form.activeTo,
    timeZone: form.revision === 1 ? deviceZone || form.timeZone : form.timeZone,
    canPost: form.canPost,
    canComment: form.canComment,
    canFollow: form.canFollow,
    publishMode: form.publishMode,
    dailyPosts: Number(form.dailyPosts),
    dailyComments: Number(form.dailyComments),
    dailyFollows: Number(form.dailyFollows),
    commentsPerPost: Number(form.commentsPerPost),
    revision: form.revision,
  };
}
