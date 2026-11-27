import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { CommunityButton } from "../community/components";
import { useThemedStyles } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";
import { addRecentEmoji, EMOJI_GROUPS, emojiStorageKey, readRecentEmoji } from "./emoji";

type EmojiGroup = (typeof EMOJI_GROUPS)[number]["id"] | "recent";
const TABS = [{ id: "recent", title: "最近使用" }, ...EMOJI_GROUPS] as const;
const TOUCH_TARGET = 44;
const MAX_GRID_HEIGHT = 184;
const SCREEN_HEIGHT_SHARE = 0.24;
const pendingWrites = new Map<string, Promise<string[]>>();

function loadRecent(key: string): Promise<string[]> {
  return pendingWrites.get(key) ?? AsyncStorage.getItem(key).then(readRecentEmoji);
}

function rememberEmoji(key: string, emoji: string): Promise<string[]> {
  const writing = loadRecent(key).catch(() => AsyncStorage.getItem(key).then(readRecentEmoji)).then(async recent => {
    const next = addRecentEmoji(recent, emoji);
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return next;
  });
  pendingWrites.set(key, writing);
  const finish = () => {
    if (pendingWrites.get(key) === writing) pendingWrites.delete(key);
  };
  void writing.then(finish, finish);
  return writing;
}

export function ChatEmojiPanel({ ownerId, onInsert }: { ownerId: string; onInsert: (emoji: string) => boolean }) {
  const styles = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const [group, setGroup] = useState<EmojiGroup>("faces");
  const [recent, setRecent] = useState<string[]>();
  const [storageError, setStorageError] = useState(false);
  const generation = useRef(0);
  const key = emojiStorageKey(ownerId);

  useEffect(() => {
    const current = ++generation.current;
    void loadRecent(key).then(items => {
      if (current === generation.current) setRecent(items);
    }).catch(() => {
      if (current === generation.current) setStorageError(true);
    });
    return () => { generation.current++; };
  }, [key]);

  function selectEmoji(emoji: string) {
    if (!onInsert(emoji)) return;
    const current = ++generation.current;
    void rememberEmoji(key, emoji).then(items => {
      if (current !== generation.current) return;
      setRecent(items);
      setStorageError(false);
    }).catch(() => {
      if (current === generation.current) setStorageError(true);
    });
  }

  const items = group === "recent" ? recent ?? [] : EMOJI_GROUPS.find(item => item.id === group)?.items ?? [];
  return <View style={styles.panel}>
    <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tabs}>
      {TABS.map(tab => <CommunityButton key={tab.id} label={tab.title} selected={tab.id === group}
        onPress={() => setGroup(tab.id)} />)}
    </ScrollView>
    <ScrollView key={group} keyboardShouldPersistTaps="always"
      style={{ maxHeight: Math.max(TOUCH_TARGET, Math.min(MAX_GRID_HEIGHT, height * SCREEN_HEIGHT_SHARE)) }}
      contentContainerStyle={styles.grid}>
      {items.map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`插入 ${emoji}`}
        onPress={() => selectEmoji(emoji)} style={styles.emoji}>
        <Text style={styles.glyph}>{emoji}</Text>
      </Pressable>)}
      {group === "recent" && storageError && <Text accessibilityLiveRegion="polite" style={styles.meta}>
        最近使用暂时无法同步到本机。
      </Text>}
      {group === "recent" && !storageError && items.length === 0 &&
        <Text style={styles.meta}>{recent ? "选过的表情会出现在这里。" : "正在读取最近使用…"}</Text>}
    </ScrollView>
  </View>;
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  panel: { gap: 6, paddingBottom: 6 },
  tabs: { gap: 6, alignItems: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  emoji: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: "center", justifyContent: "center",
    borderRadius: RADIUS.bubble, backgroundColor: ui.background[0] },
  glyph: { fontSize: 22 },
  meta: { color: ui.muted, paddingVertical: 10 },
});
