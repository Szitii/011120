import AsyncStorage from "@react-native-async-storage/async-storage";
import type { UiPalette } from "./skinTokens";

export type BubbleSkinId = "default" | "cream" | "mist";
export type ChatBgId = "pearl" | "linen" | "cloud";

export type ChatThemePreference = {
  bubbleSkin: BubbleSkinId;
  background: ChatBgId;
};

export const BUBBLE_SKINS: ReadonlyArray<{ id: BubbleSkinId; label: string }> = [
  { id: "default", label: "冰雾蓝" },
  { id: "cream", label: "奶杏白" },
  { id: "mist", label: "雾霭蓝" },
];

export const CHAT_BACKGROUNDS: ReadonlyArray<{ id: ChatBgId; label: string; colors: readonly [string, string] }> = [
  { id: "pearl", label: "暖珍珠", colors: ["#F6F5F0", "#F0E9E1"] },
  { id: "linen", label: "暖米纸", colors: ["#F8F4EC", "#EFE6D8"] },
  { id: "cloud", label: "冰云灰", colors: ["#F2F5F9", "#E6ECF4"] },
];

export function resolveChatThemeStyles(pref: ChatThemePreference, ui: UiPalette) {
  const bg = pref.background === "pearl" ? ui.background : CHAT_BACKGROUNDS.find(b => b.id === pref.background)?.colors ?? ui.background;
  if (pref.bubbleSkin === "cream") {
    return {
      background: bg,
      mineBg: "#E9DFD3",
      mineBorder: "#DDD0C0",
      mineText: "#2F2B27",
      otherBg: ui.white,
      otherBorder: ui.line,
    };
  }
  if (pref.bubbleSkin === "mist") {
    return {
      background: bg,
      mineBg: ui.accent,
      mineBorder: ui.accent,
      mineText: ui.onAccent,
      otherBg: ui.white,
      otherBorder: ui.line,
    };
  }
  return {
    background: bg,
    mineBg: ui.iceBlue,
    mineBorder: ui.highlight,
    mineText: ui.mineInk,
    otherBg: ui.white,
    otherBorder: ui.line,
  };
}

const storageKey = (ownerId: string, chatId: string) => `companion:chat-theme:v2:${JSON.stringify([ownerId, chatId])}`;

export async function loadChatTheme(ownerId: string, chatId: string): Promise<ChatThemePreference> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(ownerId, chatId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatThemePreference>;
      return {
        bubbleSkin: parsed.bubbleSkin === "cream" || parsed.bubbleSkin === "mist" ? parsed.bubbleSkin : "default",
        background: parsed.background === "linen" || parsed.background === "cloud" ? parsed.background : "pearl",
      };
    }
  } catch {
    // fallback to default
  }
  return { bubbleSkin: "default", background: "pearl" };
}

export async function saveChatTheme(ownerId: string, chatId: string, pref: ChatThemePreference): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(ownerId, chatId), JSON.stringify(pref));
  } catch {
    // ignore storage errors
  }
}
