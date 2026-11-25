import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSettingsView } from "../../contracts/community.ts";
import { isAgentViewer } from "../src/community/client.ts";
import { settingsForm, settingsPayload } from "../src/community/agent-settings.ts";

const view: AgentSettingsView = {
  paused: false, autoEnabled: false, intervalMinutes: 180, activeFrom: "09:00", activeTo: "23:00",
  timeZone: "Asia/Shanghai", canPost: false, canComment: true, canFollow: false,
  publishMode: "DRAFT", dailyPosts: 3, dailyComments: 10, dailyFollows: 5, commentsPerPost: 3,
  revision: 1, localTime: "11/22 19:00",
  usage: { postsToday: 0, commentsToday: 0, followsToday: 0, pendingDrafts: 0 },
};

test("agent pages accept both AI identities and exclude the human view", () => {
  assert.equal(isAgentViewer({ kind: "OWNER", id: "owner" }), false);
  assert.equal(isAgentViewer(undefined), false);
  assert.equal(isAgentViewer({ kind: "COMPANION", id: "companion" }), true);
  assert.equal(isAgentViewer({ kind: "SOCIAL_TWIN", id: "twin" }), true);
});

test("settings PUT excludes read-only fields and chooses device time zone only on first save", () => {
  const { localTime, usage, ...expected } = view;
  assert.deepEqual(settingsPayload(settingsForm(view), "Europe/Paris"), { ...expected, timeZone: "Europe/Paris" });
  assert.deepEqual(settingsPayload(settingsForm(view)), expected);
  assert.deepEqual(settingsPayload(settingsForm({ ...view, revision: 3 }), "Europe/Paris"), { ...expected, revision: 3 });
});

test("settings validate integer limits and accept all-day and cross-midnight times", () => {
  const form = settingsForm(view);
  assert.ok(settingsPayload({ ...form, activeFrom: "00:00", activeTo: "00:00", dailyPosts: "0" }));
  assert.ok(settingsPayload({ ...form, activeFrom: "23:30", activeTo: "02:00" }));
  assert.equal(settingsPayload({ ...form, activeTo: "24:00" }), undefined);
  assert.equal(settingsPayload({ ...form, dailyFollows: "51" }), undefined);
  assert.equal(settingsPayload({ ...form, dailyPosts: "" }), undefined);
  assert.equal(settingsPayload({ ...form, commentsPerPost: "0" }), undefined);
});

test("auto posting respects its interval range and preserves the selected publish mode", () => {
  const form = { ...settingsForm(view), autoEnabled: true, canPost: true, publishMode: "DIRECT" as const };
  assert.equal(settingsPayload({ ...form, intervalMinutes: "14" }), undefined);
  assert.equal(settingsPayload({ ...form, intervalMinutes: "15.5" }), undefined);
  assert.equal(settingsPayload({ ...form, intervalMinutes: "1441" }), undefined);
  assert.equal(settingsPayload({ ...form, intervalMinutes: "15" })?.autoEnabled, true);
  assert.equal(settingsPayload({ ...form, intervalMinutes: "1440" })?.intervalMinutes, 1440);
  assert.equal(settingsPayload(form)?.publishMode, "DIRECT");
});
