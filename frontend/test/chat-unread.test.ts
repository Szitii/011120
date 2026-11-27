import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../contracts/chat.ts";
import { compareChatMessages, firstUnreadMessageId, incomingChatMessages, visibleUnreadMessageId } from "../src/chat/unread.ts";

function message(id: string, sentAt: string, companionId: string | null = "companion"): ChatMessage {
  return { id, sentAt, companionId, body: id, mentions: [], status: "SENT", failure: null, retryable: false };
}

const latest = message("latest", "2026-11-27T07:00:04Z");
const own = message("own", "2026-11-27T07:00:03Z", null);
const oldestUnread = { ...message("first", "2026-11-27T07:00:02Z"), status: "FAILED" } satisfies ChatMessage;
const read = message("read", "2026-11-27T07:00:01Z", null);
const earlier = message("earlier", "2026-11-27T07:00:00Z");
const position = { unreadCount: 2, readUpTo: read.id };

test("the first unread is found across history pages without counting the owner's messages", () => {
  assert.equal(firstUnreadMessageId([latest, own], position), undefined);
  assert.equal(firstUnreadMessageId([latest, own, oldestUnread], position), oldestUnread.id);
  assert.equal(firstUnreadMessageId([latest, own, oldestUnread, read, earlier], position), oldestUnread.id);
  assert.equal(firstUnreadMessageId([latest, own, oldestUnread], { unreadCount: 2, readUpTo: null }), oldestUnread.id);
  assert.equal(firstUnreadMessageId([latest, own], { unreadCount: 0 }), undefined);
});

test("viewing older history does not advance read state to unseen messages", () => {
  const messages = [latest, own, oldestUnread, read, earlier];
  assert.equal(visibleUnreadMessageId(messages, position, new Set([earlier.id, read.id])), undefined);
  assert.equal(visibleUnreadMessageId(messages, position, new Set([own.id, oldestUnread.id, earlier.id])), oldestUnread.id);
  assert.equal(visibleUnreadMessageId(messages, position, new Set([latest.id, oldestUnread.id])), latest.id);
});

test("new arrivals exclude older pages, owned messages and content updated at the same message position", () => {
  const retry = { ...oldestUnread, status: "SENT" } satisfies ChatMessage;
  assert.deepEqual(incomingChatMessages([latest, own, retry, read, earlier], oldestUnread), [latest]);
  assert.deepEqual(incomingChatMessages([latest, own, retry], latest), []);
  assert.deepEqual(incomingChatMessages([latest, own]), [latest]);
});

test("message ordering preserves the server's sub-millisecond and id tie breaks", () => {
  const first = message("c", "2026-11-27T07:00:01.100001+00:00");
  const second = message("a", "2026-11-27T07:00:01.100002+00:00");
  const third = message("b", "2026-11-27T07:00:01.100002+00:00");
  assert.deepEqual([first, third, second].sort(compareChatMessages), [third, second, first]);
});
