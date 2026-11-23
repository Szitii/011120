import test from "node:test";
import assert from "node:assert/strict";
import {
  initialNavigationState,
  ROOT_TABS,
  popRoute,
  pushRoute,
  saveScroll,
  scrollKey,
  selectTab,
} from "../src/state/navigation.ts";

test("root navigation has community, private home, messages, and my", () => {
  assert.deepEqual(ROOT_TABS, ["world", "home", "messages", "my"]);
  const initial = initialNavigationState();
  assert.equal(initial.rootTab, "world");
  assert.deepEqual(initial.stack, [{ type: "root", tab: "world" }]);

  const home = selectTab(initial, "home");
  assert.equal(home.rootTab, "home");
  assert.deepEqual(home.stack, [{ type: "root", tab: "home" }]);

  const my = selectTab(home, "my");
  assert.equal(my.rootTab, "my");
  assert.deepEqual(my.stack, [{ type: "root", tab: "my" }]);
});

test("Life archive is a detail route from private home, rather than a separate root tab", () => {
  const home = selectTab(initialNavigationState(), "home");
  const archive = pushRoute(home, { type: "life-archive" });
  assert.deepEqual(archive.stack[1], { type: "life-archive" });
  assert.deepEqual(popRoute(archive), home);
  assert.equal(archive.rootTab, "home");
});

test("switching root tabs clears detail stack but preserves identity-specific scroll offsets", () => {
  const world = saveScroll(initialNavigationState(), "owner-1", "world", 248);
  const ownerHome = pushRoute(selectTab(world, "home"), { type: "life-archive" });
  const backToCommunity = selectTab(ownerHome, "world");
  assert.deepEqual(backToCommunity.stack, [{ type: "root", tab: "world" }]);
  assert.equal(backToCommunity.scrollByIdentityAndTab[scrollKey("owner-1", "world")], 248);
  assert.notEqual(scrollKey("owner-1", "world"), scrollKey("companion-2", "world"));
});


test("chat and notification targets both return to the messages root", () => {
  const messages = selectTab(initialNavigationState(), "messages");
  assert.deepEqual(popRoute(pushRoute(messages, { type: "chat", chatId: "chat", fromTab: "messages" })), messages);
  assert.deepEqual(popRoute(pushRoute(messages, { type: "community-target", target: { type: "detail", id: "post" } })), messages);
});
