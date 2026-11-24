import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { saveRoomCapture } from "../album/capture";
import { addAlbumPhoto } from "../album/store";
import { useHomeAction } from "../chat/useHomeAction";
import type { ChatClient } from "../chat/client";
import { PearlInteractiveRoom } from "../components/PearlInteractiveRoom";
import { DIARY_SLOT_IMAGE } from "../room/roomSlots";
import { CHROME } from "../theme/layoutTokens";
import { AnniversaryPill } from "./AnniversaryPill";
import type { HomeScope } from "./keys";

export function PrivateHomeScreen({ chatClient, scope, companionName, isCompanion, isActive, onOpenDiary, onOpenAlbum }: {
  chatClient?: ChatClient;
  scope?: HomeScope;
  companionName: string;
  isCompanion: boolean;
  isActive: boolean;
  onOpenDiary?: () => void;
  onOpenAlbum?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const submitAction = useHomeAction(chatClient, scope?.companionId, isActive);
  const pendingCapture = useRef(false);
  const [capturing, setCapturing] = useState(false);
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

  return <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <PearlInteractiveRoom
      companionName={companionName}
      isCompanionView={isCompanion}
      isActive={isActive}
      onOpenDiary={openDiary}
      onAction={submitAction}
      onCapture={scope ? scene => void capture(scene) : undefined}
      capturing={capturing}
    />
    {scope && <AnniversaryPill scope={scope} />}
    {scope && <View style={styles.cards}>
      <Pressable accessibilityRole="button" accessibilityLabel="日记" style={styles.card} onPress={openDiary}>
        <Image source={DIARY_SLOT_IMAGE} style={styles.icon} resizeMode="contain" />
        <Text style={styles.label}>日记</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="相册" style={styles.card} disabled={capturing || !onOpenAlbum} onPress={onOpenAlbum}>
        <Ionicons name="images-outline" size={28} color={ui.accentInk} />
        <Text style={styles.label}>相册</Text>
      </Pressable>
    </View>}
    {notice !== "" && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
  </ScrollView>;
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: CHROME.screenInset, paddingTop: 10, paddingBottom: CHROME.scrollBottomClearance + 8, gap: 12 },
  cards: { flexDirection: "row", gap: 12 },
  card: { flex: 1, minHeight: 84, borderRadius: 16, borderWidth: 1, borderColor: ui.line,
    backgroundColor: ui.white, alignItems: "center", justifyContent: "center", gap: 3 },
  icon: { width: 29, height: 28 },
  label: { fontSize: 14, fontWeight: "600", color: ui.ink },
  notice: { textAlign: "center", color: ui.muted, fontSize: 13 },
});
