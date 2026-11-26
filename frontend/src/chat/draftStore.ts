export type ChatDraft = {
  text: string;
  mentions: string[];
};

/**
 * In-memory drafts for chat composer input. One store lives inside the signed-in
 * world scope, so signing out (or switching accounts) drops every draft with the
 * component tree. Nothing here touches AsyncStorage.
 */
export interface ChatDraftStore {
  read(key: string | undefined): ChatDraft;
  write(key: string | undefined, draft: ChatDraft): void;
  clear(key: string | undefined): void;
  /**
   * Move a draft from a provisional key (companion-only, before a chat exists)
   * onto the resolved chat key. A non-empty provisional draft wins because it is
   * the text the owner just typed; otherwise the resolved draft is kept.
   */
  adopt(from: string | undefined, to: string | undefined): ChatDraft;
}

const emptyDraft = (): ChatDraft => ({ text: "", mentions: [] });

export function chatDraftKey(
  accountId: string | undefined,
  target: { chatId?: string; companionId?: string },
): string | undefined {
  if (!accountId) return undefined;
  if (target.chatId) return `${accountId}|chat|${target.chatId}`;
  if (target.companionId) return `${accountId}|companion|${target.companionId}`;
  return undefined;
}

export function createChatDraftStore(): ChatDraftStore {
  const drafts = new Map<string, ChatDraft>();

  const read = (key: string | undefined): ChatDraft => {
    if (!key) return emptyDraft();
    const value = drafts.get(key);
    return value ? { text: value.text, mentions: [...value.mentions] } : emptyDraft();
  };

  const write = (key: string | undefined, draft: ChatDraft) => {
    if (!key) return;
    if (draft.text === "" && draft.mentions.length === 0) {
      drafts.delete(key);
      return;
    }
    drafts.set(key, { text: draft.text, mentions: [...draft.mentions] });
  };

  return {
    read,
    write,
    clear: key => {
      if (key) drafts.delete(key);
    },
    adopt: (from, to) => {
      if (!to || !from || from === to) return read(to ?? from);
      const provisional = read(from);
      const chosen = provisional.text !== "" || provisional.mentions.length > 0
        ? provisional
        : read(to);
      drafts.delete(from);
      write(to, chosen);
      return read(to);
    },
  };
}
