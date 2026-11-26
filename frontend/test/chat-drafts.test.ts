import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatDraftKey, createChatDraftStore } from "../src/chat/draftStore.ts";

describe("in-memory chat drafts", () => {
  it("isolates drafts by account and conversation", () => {
    const store = createChatDraftStore();
    const aliceChat = chatDraftKey("owner-a", { chatId: "chat-1" });
    const aliceOtherChat = chatDraftKey("owner-a", { chatId: "chat-2" });
    const bobChat = chatDraftKey("owner-b", { chatId: "chat-1" });
    assert.ok(aliceChat && aliceOtherChat && bobChat);

    store.write(aliceChat, { text: "晚点再说", mentions: ["companion-1"] });
    store.write(bobChat, { text: "另一个账号", mentions: [] });

    assert.deepEqual(store.read(aliceChat), { text: "晚点再说", mentions: ["companion-1"] });
    assert.deepEqual(store.read(aliceOtherChat), { text: "", mentions: [] });
    assert.deepEqual(store.read(bobChat), { text: "另一个账号", mentions: [] });
  });

  it("requires an account scope before keeping anything", () => {
    assert.equal(chatDraftKey(undefined, { chatId: "chat-1" }), undefined);
    assert.equal(chatDraftKey("owner-a", {}), undefined);

    const store = createChatDraftStore();
    store.write(undefined, { text: "不落盘", mentions: [] });
    assert.deepEqual(store.read(undefined), { text: "", mentions: [] });
  });

  it("carries a companion-only draft onto the resolved chat", () => {
    const store = createChatDraftStore();
    const provisional = chatDraftKey("owner-a", { companionId: "companion-1" });
    const resolved = chatDraftKey("owner-a", { chatId: "chat-9" });
    assert.ok(provisional && resolved);

    store.write(provisional, { text: "还没发出去", mentions: [] });
    const adopted = store.adopt(provisional, resolved);

    assert.deepEqual(adopted, { text: "还没发出去", mentions: [] });
    assert.deepEqual(store.read(resolved), { text: "还没发出去", mentions: [] });
    assert.deepEqual(store.read(provisional), { text: "", mentions: [] });
  });

  it("keeps the resolved chat draft when no provisional text was typed", () => {
    const store = createChatDraftStore();
    const provisional = chatDraftKey("owner-a", { companionId: "companion-1" });
    const resolved = chatDraftKey("owner-a", { chatId: "chat-9" });
    assert.ok(provisional && resolved);

    store.write(resolved, { text: "上次写到一半", mentions: ["companion-2"] });
    const adopted = store.adopt(provisional, resolved);

    assert.deepEqual(adopted, { text: "上次写到一半", mentions: ["companion-2"] });
    assert.deepEqual(store.read(provisional), { text: "", mentions: [] });
  });

  it("removes only the submitted draft and keeps text typed while sending", () => {
    const store = createChatDraftStore();
    const key = chatDraftKey("owner-a", { chatId: "chat-1" });
    assert.ok(key);

    store.write(key, { text: "第一条", mentions: ["companion-1"] });
    // Submitting clears the submitted text right away.
    store.write(key, { text: "", mentions: ["companion-1"] });
    // Typing during the request is kept.
    store.write(key, { text: "发送期间补的一句话", mentions: ["companion-1"] });

    assert.deepEqual(store.read(key), { text: "发送期间补的一句话", mentions: ["companion-1"] });
  });

  it("drops everything when reset", () => {
    const store = createChatDraftStore();
    const key = chatDraftKey("owner-a", { chatId: "chat-1" });
    assert.ok(key);
    store.write(key, { text: "一条草稿", mentions: [] });
    store.clear(key);
    assert.deepEqual(store.read(key), { text: "", mentions: [] });
  });

  it("queries drafts by accountId and chatId via readByChatId without mutating state", () => {
    const store = createChatDraftStore();
    let notifications = 0;
    const unsubscribe = store.subscribe?.(() => { notifications += 1; });

    const aliceChat = chatDraftKey("owner-a", { chatId: "chat-42" });
    const aliceCompanionOnly = chatDraftKey("owner-a", { companionId: "comp-1" });
    assert.ok(aliceChat && aliceCompanionOnly);

    store.write(aliceChat, { text: "草稿内容", mentions: ["comp-1"] });
    store.write(aliceCompanionOnly, { text: "临时草稿", mentions: [] });

    const queried = store.readByChatId("owner-a", "chat-42");
    assert.deepEqual(queried, { text: "草稿内容", mentions: ["comp-1"] });
    // Mutating returned object must not mutate stored draft.
    queried.mentions.push("comp-2");
    assert.deepEqual(store.readByChatId("owner-a", "chat-42"), { text: "草稿内容", mentions: ["comp-1"] });

    assert.deepEqual(store.readByChatId("owner-b", "chat-42"), { text: "", mentions: [] });
    assert.deepEqual(store.readByChatId(undefined, "chat-42"), { text: "", mentions: [] });
    assert.deepEqual(store.readByChatId("owner-a", undefined), { text: "", mentions: [] });

    const beforeClear = notifications;
    store.clear(aliceChat);
    assert.equal(notifications, beforeClear + 1);
    assert.deepEqual(store.readByChatId("owner-a", "chat-42"), { text: "", mentions: [] });
    unsubscribe?.();
  });
});
