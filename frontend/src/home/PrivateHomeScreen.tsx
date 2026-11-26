import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { saveRoomCapture } from "../album/capture";
import { addAlbumPhoto } from "../album/store";
import { useHomeAction } from "../chat/useHomeAction";
import type { ChatClient } from "../chat/client";
import { BottomSheet } from "../components/BottomSheet";
import { PearlInteractiveRoom } from "../components/PearlInteractiveRoom";
import { PixelAvatar } from "../components/PixelAvatar";
import type { OwnerCompanionSummary } from "../contracts";
import { ALBUM_SLOT_IMAGE, DIARY_SLOT_IMAGE } from "../room/roomSlots";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { AnniversaryPill } from "./AnniversaryPill";
import type { HomeScope } from "./keys";

export function PrivateHomeScreen({
  chatClient,
  scope,
  companionName,
  companionAvatar,
  companions = [],
  onSelectCompanion,
  isCompanion,
  isActive,
  onOpenDiary,
  onOpenAlbum,
}: {
  chatClient?: ChatClient;
  scope?: HomeScope;
  companionName: string;
  companionAvatar?: string | null;
  companions?: OwnerCompanionSummary[];
  onSelectCompanion?: (companionId: string) => void;
  isCompanion: boolean;
  isActive: boolean;
  onOpenDiary?: () => void;
  onOpenAlbum?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [externalAction, setExternalAction] = useState<{ key: number; action: CompanionAction } | null>(null);
  const [companionSpeech, setCompanionSpeech] = useState<string | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (speechTimer.current) clearTimeout(speechTimer.current); }, []);
  const submitAction = useHomeAction(chatClient, scope?.companionId, isActive, {
    onCompanionAction: action => setExternalAction(prev => ({ key: (prev?.key ?? 0) + 1, action })),
    onCompanionSpeech: body => {
      setCompanionSpeech(body);
      if (speechTimer.current) clearTimeout(speechTimer.current);
      speechTimer.current = setTimeout(() => setCompanionSpeech(null), 4500);
    },
  });
  const pendingCapture = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [notice, setNotice] = useState("");

  async function capture(scene: ComponentRef<typeof View>) {
    if (!scope || !isActive || pendingCapture.current) return;
    pendingCapture.current = true;
    setCapturing(true);
    setNotice("");
    try {
      await saveRoomCapture(scene, uri => addAlbumPhoto(scope, "room_snapshot", uri, "png"));
      setNotice("已存入相册。");
    } catch {
      setNotice("这张照片没保存成功，请再拍一次。");
    } finally {
      pendingCapture.current = false;
      setCapturing(false);
    }
  }

  function openDiary() {
    if (onOpenDiary) onOpenDiary();
    else setNotice(isCompanion ? "日记由主人打开。" : "请先添加家机，或等待小家资料加载完成。");
  }

  const canSwitch = !isCompanion && companions.length > 1 && Boolean(onSelectCompanion);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {canSwitch && (
        <View style={styles.switchRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="切换小家家机"
            onPress={() => setSwitcherOpen(true)}
            style={({ pressed }) => [styles.switchPill, pressed && { opacity: 0.8 }]}
          >
            <PixelAvatar name={companionName} role="companion" uri={companionAvatar} size={20} />
            <Text style={styles.switchText}>小家里：{companionName}</Text>
            <Ionicons name="chevron-down" size={14} color={ui.accentInk} />
          </Pressable>
        </View>
      )}

      <PearlInteractiveRoom
        companionName={companionName}
        isCompanionView={isCompanion}
        isActive={isActive}
        externalAction={externalAction}
        companionSpeech={companionSpeech}
        onOpenDiary={openDiary}
        onAction={submitAction}
        onCapture={scope ? scene => void capture(scene) : undefined}
        capturing={capturing}
      />
      {scope && <AnniversaryPill scope={scope} client={chatClient} active={isActive} />}
      {scope && (
        <View style={styles.cards}>
          <Pressable accessibilityRole="button" accessibilityLabel="日记" style={styles.card} onPress={openDiary}>
            <Image source={DIARY_SLOT_IMAGE} style={styles.icon} resizeMode="contain" />
            <Text style={styles.label}>日记</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="相册" style={styles.card} disabled={capturing || !onOpenAlbum} onPress={onOpenAlbum}>
            <Image source={ALBUM_SLOT_IMAGE} style={styles.icon} resizeMode="contain" />
            <Text style={styles.label}>相册</Text>
          </Pressable>
        </View>
      )}
      {notice !== "" && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}

      <BottomSheet visible={switcherOpen} title="选择住在小家里的家机" onClose={() => setSwitcherOpen(false)}>
        <View style={styles.sheetList}>
          {companions.map(item => {
            const active = item.companionId === scope?.companionId;
            return (
              <Pressable
                key={item.companionId}
                accessibilityRole="button"
                onPress={() => {
                  onSelectCompanion?.(item.companionId);
                  setSwitcherOpen(false);
                }}
                style={[styles.sheetItem, active && styles.sheetItemActive]}
              >
                <PixelAvatar name={item.displayName} role="companion" uri={item.avatar} size={34} />
                <Text style={[styles.sheetName, active && styles.sheetNameActive]}>{item.displayName}</Text>
                {active && <Ionicons name="checkmark-circle" size={20} color={ui.accent} />}
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>
    </ScrollView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: CHROME.screenInset, paddingTop: 10, paddingBottom: CHROME.scrollBottomClearance + 8, gap: 12 },
  switchRow: { flexDirection: "row", justifyContent: "flex-start" },
  switchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  switchText: { fontSize: 13, fontWeight: "600", color: ui.ink },
  cards: { flexDirection: "row", gap: 12 },
  card: {
    flex: 1, minHeight: 84, borderRadius: 16, borderWidth: 1, borderColor: ui.line,
    backgroundColor: ui.white, alignItems: "center", justifyContent: "center", gap: 3,
  },
  icon: { width: 29, height: 28 },
  label: { fontSize: 14, fontWeight: "600", color: ui.ink },
  notice: { textAlign: "center", color: ui.muted, fontSize: 13 },
  sheetList: { gap: 8 },
  sheetItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
    backgroundColor: ui.background[0],
  },
  sheetItemActive: {
    backgroundColor: ui.accentWash,
    borderWidth: 1,
    borderColor: ui.accent,
  },
  sheetName: { flex: 1, fontSize: 15, fontWeight: "600", color: ui.ink },
  sheetNameActive: { color: ui.accentInk },
});
