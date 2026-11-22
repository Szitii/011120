import React, { useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { GlassChatBubble } from "./GlassChatBubble";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";

const ROOM_CUTE_IMG = require("../../assets/room-cute-flat.jpg");

interface QuickMsg {
  id: string;
  role: "human" | "ai";
  text: string;
}

export function FlatRoomPreview({
  companionName,
  recordCount,
}: {
  companionName: string;
  recordCount: number;
}) {
  const { skin } = useSkin();
  const [catMood, setCatMood] = useState("打盹中");
  const [warmTea, setWarmTea] = useState(true);
  const [roomToast, setRoomToast] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<null | "note" | "album" | "anniversary" | "wishlist" | "chat">(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<QuickMsg[]>([
    { id: "m1", role: "ai", text: "看你昨晚说肩颈酸，把沙发靠枕换软了一点，回来靠着歇会儿。" },
  ]);

  function flashTip(msg: string) {
    setRoomToast(msg);
    setTimeout(() => setRoomToast((cur) => (cur === msg ? null : cur)), 2400);
  }

  function sendQuickMessage(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setMessages((prev) => [
      ...prev,
      { id: `h-${Date.now()}`, role: "human", text: clean },
      {
        id: `a-${Date.now() + 1}`,
        role: "ai",
        text: "嗯，记着呢。今天别再熬太晚了。",
      },
    ]);
    setChatInput("");
  }

  const tiles: Array<{
    key: "album" | "anniversary" | "note" | "wishlist";
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
  }> = [
    { key: "album", icon: "images-outline", label: "相册" },
    { key: "anniversary", icon: "calendar-outline", label: "纪念日" },
    { key: "note", icon: "document-text-outline", label: "便签" },
    { key: "wishlist", icon: "heart-outline", label: "愿望单" },
  ];

  return (
    <View>
      {/* Hand-Drawn Cute Flat 2D Room with Real Liquid Glass Floating Pills */}
      <View style={[styles.roomFrame, { borderColor: skin.colors.border }]}>
        <Image source={ROOM_CUTE_IMG} style={styles.roomImage} resizeMode="cover" />

        {/* Top-left Liquid Glass Status Pill */}
        <View style={styles.topBadgeWrap}>
          <LiquidGlassSurface variant="chip" borderRadius={RADIUS.pill}>
            <View style={styles.topBadgeInner}>
              <View style={[styles.statusDot, { backgroundColor: skin.identityBadges.relationDot }]} />
              <Text style={styles.topBadgeText}>
                {roomToast ?? (recordCount > 0 ? `${recordCount} 件关于你的小事` : "今天屋里很安静")}
              </Text>
            </View>
          </LiquidGlassSurface>
        </View>

        {/* Interactive Hotspot 1: Sleeping Black Cat */}
        <Pressable
          onPress={() => {
            setCatMood((m) => (m === "打盹中" ? "咕噜咕噜" : "打盹中"));
            flashTip("摸了摸小黑猫，它舒服地翻了个身");
          }}
          style={({ pressed }) => [styles.hotspotCat, pressed && { transform: [{ scale: 0.92 }] }]}
        >
          <LiquidGlassSurface variant="chip" borderRadius={RADIUS.pill}>
            <View style={styles.hotspotInner}>
              <View style={[styles.hotDot, { backgroundColor: "#18181B" }]} />
              <Text style={styles.hotspotText}>小黑猫 · {catMood}</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>

        {/* Interactive Hotspot 2: Warm Mug on Table */}
        <Pressable
          onPress={() => {
            setWarmTea((v) => !v);
            flashTip(warmTea ? "喝了一口温热的红茶" : "沈砚又帮你倒了一杯热的");
          }}
          style={({ pressed }) => [styles.hotspotMug, pressed && { transform: [{ scale: 0.92 }] }]}
        >
          <LiquidGlassSurface variant="chip" borderRadius={RADIUS.pill}>
            <View style={styles.hotspotInner}>
              <View style={[styles.hotDot, { backgroundColor: "#F59E0B" }]} />
              <Text style={styles.hotspotText}>{warmTea ? "热红茶" : "续一杯"}</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>

        {/* Floating Quick-Chat Liquid Glass Capsule tucked cleanly at bottom-right of room */}
        <Pressable
          onPress={() => setActiveSheet("chat")}
          style={({ pressed }) => [styles.roomChatFloat, pressed && { transform: [{ scale: 0.94 }] }]}
        >
          <LiquidGlassSurface variant="chip" borderRadius={RADIUS.pill}>
            <View style={styles.roomChatFloatInner}>
              <Ionicons name="chatbubble-ellipses-outline" size={14} color="#18181B" />
              <Text style={styles.roomChatFloatText}>跟{companionName}说一句</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>
      </View>

      {/* Ultra-Clean Pure White Minimal Shortcut Row (ZERO cheap gradient box!) */}
      <View style={styles.tileGrid}>
        {tiles.map((t) => (
          <Pressable
            key={t.key}
            style={({ pressed }) => [
              styles.cleanTile,
              { backgroundColor: skin.colors.surface, borderColor: skin.colors.border },
              pressed && { transform: [{ scale: 0.95 }], opacity: 0.8 },
            ]}
            onPress={() => setActiveSheet(t.key)}
            accessibilityRole="button"
          >
            <Ionicons name={t.icon} size={20} color={skin.colors.ink} />
            <Text style={[styles.tileLabel, { color: skin.colors.ink }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Interactive Modal Sheet */}
      <Modal
        visible={activeSheet !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActiveSheet(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActiveSheet(null)}>
          <Pressable
            style={[
              styles.sheetBox,
              { backgroundColor: skin.colors.canvas, borderColor: skin.colors.border },
            ]}
            onPress={() => undefined}
          >
            <View style={[styles.sheetHandle, { backgroundColor: skin.colors.border }]} />

            {activeSheet === "chat" && (
              <View>
                <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>和 {companionName} 聊聊</Text>
                <View style={[styles.chatStage, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
                  <ScrollView contentContainerStyle={{ padding: 12 }}>
                    {messages.map((m) => (
                      <GlassChatBubble key={m.id} senderRole={m.role} text={m.text} />
                    ))}
                  </ScrollView>
                </View>
                <View style={styles.quickChipsRow}>
                  {["靠枕挺舒服的", "周末去喝糖水", "晚安"].map((q) => (
                    <Pressable
                      key={q}
                      onPress={() => sendQuickMessage(q)}
                      style={[
                        styles.quickChip,
                        { backgroundColor: skin.colors.surface, borderColor: skin.colors.border },
                      ]}
                    >
                      <Text style={[styles.quickChipText, { color: skin.colors.ink }]}>{q}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.inputRow}>
                  <TextInput
                    value={chatInput}
                    onChangeText={setChatInput}
                    placeholder="说点什么..."
                    placeholderTextColor={skin.colors.inkMute}
                    style={[
                      styles.textInput,
                      {
                        backgroundColor: skin.colors.surface,
                        borderColor: skin.colors.border,
                        color: skin.colors.ink,
                      },
                    ]}
                    returnKeyType="send"
                    onSubmitEditing={() => sendQuickMessage(chatInput)}
                  />
                  <Pressable
                    onPress={() => sendQuickMessage(chatInput)}
                    style={[styles.sendBtn, { backgroundColor: skin.colors.accent }]}
                  >
                    <Text style={[styles.sendBtnText, { color: skin.colors.accentFg }]}>发送</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {activeSheet === "note" && (
              <View>
                <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>茶几上的便签</Text>
                <View
                  style={[
                    styles.noteCard,
                    {
                      backgroundColor: skin.profileAndNotes.noteCardBg,
                      borderColor: skin.profileAndNotes.noteCardBorder,
                    },
                  ]}
                >
                  <Text style={[styles.noteBody, { color: skin.colors.ink }]}>
                    “你随口提过的那家糖水铺记进周末清单了。今晚别再刷手机到两点，早点睡。”
                  </Text>
                  <Text style={[styles.noteMeta, { color: skin.colors.inkMute }]}>{companionName}</Text>
                </View>
                <Pressable
                  onPress={() => {
                    setActiveSheet(null);
                    flashTip("便签已收进纪念册");
                  }}
                  style={[styles.primaryBtn, { backgroundColor: skin.colors.accent }]}
                >
                  <Text style={[styles.primaryBtnText, { color: skin.colors.accentFg }]}>收进纪念册</Text>
                </Pressable>
              </View>
            )}

            {(activeSheet === "album" || activeSheet === "anniversary" || activeSheet === "wishlist") && (
              <View>
                <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>
                  {activeSheet === "album"
                    ? "共同相册"
                    : activeSheet === "anniversary"
                      ? "纪念日 · 相伴 128 天"
                      : "共同愿望单"}
                </Text>
                <Text style={[styles.sheetSub, { color: skin.colors.inkSub }]}>
                  {activeSheet === "album"
                    ? "只属于你们两个人的私密相册，照片与标签功能即将开放。"
                    : activeSheet === "anniversary"
                      ? "记录你们的重要日子与纪念卡片，自定义日期即将开放。"
                      : "家机挑中的小家家具或主题皮肤会先放进愿望单，由你决定，不会自动扣款。"}
                </Text>
                <Pressable
                  onPress={() => setActiveSheet(null)}
                  style={[styles.primaryBtn, { backgroundColor: skin.colors.accent }]}
                >
                  <Text style={[styles.primaryBtnText, { color: skin.colors.accentFg }]}>好的</Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  roomFrame: {
    height: 292,
    borderRadius: 26,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
  },
  roomImage: { width: "100%", height: "100%" },
  topBadgeWrap: { position: "absolute", top: 12, left: 12 },
  topBadgeInner: { flexDirection: "row", alignItems: "center", paddingHorizontal: 11, paddingVertical: 5, gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  topBadgeText: { fontSize: 11, fontWeight: "600", color: "#18181B" },
  hotspotCat: { position: "absolute", right: "24%", top: "45%" },
  hotspotMug: { position: "absolute", left: "16%", top: "64%" },
  hotspotInner: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 5, gap: 5 },
  hotDot: { width: 6.5, height: 6.5, borderRadius: 3.5 },
  hotspotText: { fontSize: 11, fontWeight: "600", color: "#18181B" },
  roomChatFloat: { position: "absolute", right: 12, bottom: 12 },
  roomChatFloatInner: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 7, gap: 6 },
  roomChatFloatText: { fontSize: 11.5, fontWeight: "600", color: "#18181B" },
  tileGrid: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },
  cleanTile: {
    flex: 1,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  tileLabel: { fontSize: 11.5, fontWeight: "500" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.34)", justifyContent: "flex-end" },
  sheetBox: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    padding: 20,
    paddingBottom: 34,
  },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 14 },
  sheetTitle: { fontSize: 17, fontWeight: "700", marginBottom: 10 },
  sheetSub: { fontSize: 13, lineHeight: 20, marginBottom: 16 },
  chatStage: { maxHeight: 220, borderRadius: 20, borderWidth: 1, marginBottom: 12, overflow: "hidden" },
  quickChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  quickChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  quickChipText: { fontSize: 12, fontWeight: "500" },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  textInput: { flex: 1, height: 40, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, fontSize: 13 },
  sendBtn: { height: 40, paddingHorizontal: 18, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  sendBtnText: { fontSize: 13, fontWeight: "600" },
  noteCard: { borderRadius: 18, borderWidth: 1, padding: 16, marginBottom: 14 },
  noteBody: { fontSize: 14, lineHeight: 22 },
  noteMeta: { fontSize: 11.5, marginTop: 10 },
  primaryBtn: { height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  primaryBtnText: { fontSize: 14, fontWeight: "600" },
});
