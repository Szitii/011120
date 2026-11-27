import type { Chat, ChatMessage } from "../../../contracts/chat.ts";

type ReadPosition = Pick<Chat, "unreadCount" | "readUpTo">;

export function firstUnreadMessageId(messages: readonly ChatMessage[], position: ReadPosition): string | undefined {
  if (!position.unreadCount) return undefined;
  const readIndex = position.readUpTo ? messages.findIndex(message => message.id === position.readUpTo) : -1;
  if (readIndex >= 0) {
    for (let index = readIndex - 1; index >= 0; index--) {
      if (messages[index].companionId !== null) return messages[index].id;
    }
    return undefined;
  }
  let remaining = position.unreadCount;
  for (const message of messages) {
    if (message.companionId !== null && --remaining === 0) return message.id;
  }
  return undefined;
}

export function visibleUnreadMessageId(
  messages: readonly ChatMessage[],
  position: ReadPosition,
  visibleIds: ReadonlySet<string>,
): string | undefined {
  const first = firstUnreadMessageId(messages, position);
  if (!first) return undefined;
  for (const message of messages) {
    if (message.companionId !== null && visibleIds.has(message.id)) return message.id;
    if (message.id === first) break;
  }
  return undefined;
}

/** Same newest-first ordering as the server, including ties within the same instant. */
export function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const time = Date.parse(b.sentAt) - Date.parse(a.sentAt);
  if (time) return time;
  // PostgreSQL can return microseconds, which Date.parse truncates.
  const fraction = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  const subsecond = fraction(b.sentAt).localeCompare(fraction(a.sentAt));
  return subsecond || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function incomingChatMessages(messages: readonly ChatMessage[], previousHead?: ChatMessage): ChatMessage[] {
  return messages.filter(message => message.companionId !== null
    && (!previousHead || compareChatMessages(message, previousHead) < 0));
}
