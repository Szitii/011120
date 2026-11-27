import assert from "node:assert/strict";
import { test } from "node:test";
import { addRecentEmoji, EMOJI_GROUPS, emojiStorageKey, insertChatEmoji, readRecentEmoji } from "../src/chat/emoji.ts";

test("emoji insertion replaces a selection and continues from the updated caret", () => {
  const first = insertChatEmoji("今天开心", "😊", { start: 2, end: 4 }, 20);
  assert.deepEqual(first, { text: "今天😊", selection: { start: 4, end: 4 } });
  const second = insertChatEmoji(first!.text, "❤️", first!.selection, 20);
  assert.equal(second?.text, "今天😊❤️");
  assert.equal(insertChatEmoji("草稿已恢复", "🐶", undefined, 20)?.text, "草稿已恢复🐶");
});

test("emoji insertion applies the server code-point limit without clipping a sequence", () => {
  const draft = "🐶".repeat(1999);
  assert.equal(insertChatEmoji(draft, "😊", undefined, 2000)?.text, draft + "😊");
  assert.equal(insertChatEmoji(draft, "❤️‍🩹", undefined, 2000), undefined);
  assert.equal(insertChatEmoji("🐶", "😊", { start: 1, end: 1 }, 2)?.text, "😊🐶");
  assert.equal(insertChatEmoji("🐶".repeat(2000), "😊", { start: 0, end: 2 }, 2000)?.text.startsWith("😊"), true);
});

test("recent emoji are account-scoped, deduplicated, validated and capped", () => {
  assert.notEqual(emojiStorageKey("owner-a"), emojiStorageKey("owner-b"));
  const recent = readRecentEmoji('["😊", "other", "❤️", "😊", 42]');
  assert.deepEqual(recent, ["😊", "❤️"]);
  assert.deepEqual(addRecentEmoji(recent, "❤️"), ["❤️", "😊"]);
  assert.deepEqual(readRecentEmoji("{"), []);
  const many = EMOJI_GROUPS.flatMap(group => group.items);
  assert.equal(many.reduce(addRecentEmoji, []).length, 24);
});
