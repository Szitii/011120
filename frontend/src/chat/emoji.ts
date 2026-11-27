export const EMOJI_GROUPS = [
  { id: "faces", title: "笑脸", items: ["😊", "🥺", "😂", "😭", "😄", "🤣", "😍", "🥰", "😘", "😆", "😉", "😎", "🤔", "🤭", "🤫", "😅", "🙃", "😌", "😳", "😴", "🙈", "😮", "😢", "😤", "😠", "🙄", "🥹", "😇"] },
  { id: "gestures", title: "手势", items: ["👍", "👎", "👏", "👋", "🙌", "🙏", "✌️", "🤝", "🫶", "🫂", "💪", "👌", "🤞", "✋", "🤟", "👀", "☝️", "🤗"] },
  { id: "hearts", title: "爱心", items: ["❤️", "🩷", "🧡", "💛", "💚", "💙", "💜", "🤍", "🤎", "🖤", "💕", "💗", "💖", "💝", "💔", "❤️‍🩹", "💌", "✨"] },
  { id: "nature", title: "自然", items: ["🐶", "🐱", "🐰", "🐻", "🦊", "🐼", "🌸", "🌷", "🌿", "🍀", "🌙", "⭐", "☀️", "☁️", "🌧️", "❄️", "🌈", "🌻"] },
  { id: "daily", title: "日常", items: ["☕️", "🍵", "🧋", "🍰", "🍓", "🍜", "🍕", "🎂", "🎁", "🎉", "🎈", "🎵", "📚", "📷", "💤", "🏠", "🧸", "🕯️"] },
] as const;

const knownEmoji = new Set<string>(EMOJI_GROUPS.flatMap(group => group.items));
const MAX_RECENT_EMOJI = 24;

export type ComposerSelection = { start: number; end: number };

export function emojiStorageKey(ownerId: string): string {
  return `chat:recent-emoji:v1:${encodeURIComponent(ownerId)}`;
}

export function readRecentEmoji(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && knownEmoji.has(item)))].slice(0, MAX_RECENT_EMOJI)
      : [];
  } catch {
    return [];
  }
}

export function addRecentEmoji(recent: string[], emoji: string): string[] {
  if (!knownEmoji.has(emoji)) return recent;
  return [emoji, ...recent.filter(item => item !== emoji)].slice(0, MAX_RECENT_EMOJI);
}

export function insertChatEmoji(
  draft: string,
  emoji: string,
  selection: ComposerSelection | undefined,
  limit: number,
): { text: string; selection: ComposerSelection } | undefined {
  function boundary(index: number) {
    const offset = Math.max(0, Math.min(index, draft.length));
    if (/[\uD800-\uDBFF]/.test(draft.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(draft.charAt(offset))) {
      return offset - 1;
    }
    return offset;
  }
  const start = boundary(selection?.start ?? draft.length);
  const end = Math.max(start, boundary(selection?.end ?? start));
  const text = draft.slice(0, start) + emoji + draft.slice(end);
  if (Array.from(text).length > limit) return undefined;
  const caret = start + emoji.length;
  return { text, selection: { start: caret, end: caret } };
}
