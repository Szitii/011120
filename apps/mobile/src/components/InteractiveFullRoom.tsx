import React, { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { GlassChatBubble } from "./GlassChatBubble";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";

const ROOM_ISO_IMG = require("../../assets/room-iso-25d.jpg");

interface ChibiOutfit {
  id: string;
  label: string;
  hair: string;
  top: string;
  accent: string;
}

const USER_OUTFITS: ChibiOutfit[] = [
  { id: "cream-knit", label: "奶油针织", hair: "#4A3228", top: "#F8D4DC", accent: "#E17088" },
  { id: "preppy-blue", label: "学院蓝白", hair: "#3B2F2F", top: "#BFDBFE", accent: "#2563EB" },
  { id: "cozy-pj", label: "居家睡衣", hair: "#5C4033", top: "#FEF3C7", accent: "#D97706" },
];

const COMPANION_OUTFITS: ChibiOutfit[] = [
  { id: "charcoal-knit", label: "深灰毛衣", hair: "#1F242D", top: "#475569", accent: "#94A3B8" },
  { id: "white-shirt", label: "清爽白衬", hair: "#27272A", top: "#F8FAFC", accent: "#3B82F6" },
  { id: "sage-hoodie", label: "灰绿卫衣", hair: "#2D2926", top: "#84A98C", accent: "#52796F" },
];

const COMPANION_LINES = [
  "回来了？茶还温着。",
  "别光戳我，先坐会儿。",
  "昨晚看你肩颈酸，把靠枕换软了。",
  "周末那家糖水铺，记在备忘录里了。",
];

function ChibiAvatar({
  outfit,
  name,
  bubbleText,
  isCompanion,
}: {
  outfit: ChibiOutfit;
  name: string;
  bubbleText?: string | null;
  isCompanion?: boolean;
}) {
  return (
    <View style={styles.chibiWrap}>
      {bubbleText ? (
        <View style={styles.chibiSpeech}>
          <Text style={styles.chibiSpeechText} numberOfLines={2}>
            {bubbleText}
          </Text>
        </View>
      ) : null}

      {/* Cute rounded 2D Chibi Character (matches isometric room dark-brown outline style!) */}
      <View style={styles.chibiShadow} />
      <View style={styles.chibiBodyStack}>
        {/* Head */}
        <View style={styles.chibiHead}>
          <View style={[styles.chibiHairCap, { backgroundColor: outfit.hair }]} />
          {!isCompanion && <View style={[styles.chibiBow, { backgroundColor: outfit.accent }]} />}
          <View style={styles.chibiEyesRow}>
            <View style={styles.chibiEye} />
            <View style={styles.chibiEye} />
          </View>
          <View style={styles.chibiBlushRow}>
            <View style={styles.chibiBlush} />
            <View style={styles.chibiBlush} />
          </View>
        </View>
        {/* Torso / Outfit */}
        <View style={[styles.chibiTorso, { backgroundColor: outfit.top }]}>
          <View style={[styles.chibiCollar, { backgroundColor: outfit.accent }]} />
        </View>
      </View>

      <View style={styles.chibiNameTag}>
        <Text style={styles.chibiNameText}>{name}</Text>
      </View>
    </View>
  );
}

export function InteractiveFullRoom({
  userName,
  companionName,
  isMockMode,
  recordCount,
  onOpenTimeline,
}: {
  userName: string;
  companionName: string;
  isMockMode: boolean;
  recordCount: number;
  onOpenTimeline: () => void;
}) {
  const { skin } = useSkin();
  const [stageSize, setStageSize] = useState({ width: 390, height: 680 });
  const [userOutfit, setUserOutfit] = useState<ChibiOutfit>(USER_OUTFITS[0]);
  const [compOutfit, setCompOutfit] = useState<ChibiOutfit>(COMPANION_OUTFITS[0]);
  const [roomAtmosphere, setRoomAtmosphere] = useState<"day" | "warm" | "night">("day");
  const [userBubble, setUserBubble] = useState<string | null>(null);
  const [compBubble, setCompBubble] = useState<string | null>("回来了？");
  const [lineIdx, setLineIdx] = useState(0);
  const [activeSheet, setActiveSheet] = useState<null | "memo" | "wardrobe" | "wishlist" | "chat">(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; role: "human" | "ai"; text: string }>>([
    { id: "m1", role: "ai", text: "看你昨晚说肩颈酸，把靠枕换软了，回来靠着歇会儿。" },
  ]);

  // Smooth animated position for User Chibi (starts near left/center floor)
  const userX = useRef(new Animated.Value(120)).current;
  const userY = useRef(new Animated.Value(350)).current;
  const walkBounce = useRef(new Animated.Value(0)).current;

  function onStageLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    setStageSize({ width, height });
    userX.setValue(width * 0.34);
    userY.setValue(height * 0.56);
  }

  function walkUserTo(tx: number, ty: number, bubble?: string) {
    const clampedX = Math.max(stageSize.width * 0.16, Math.min(stageSize.width * 0.80, tx));
    const clampedY = Math.max(stageSize.height * 0.38, Math.min(stageSize.height * 0.68, ty));

    if (bubble) {
      setUserBubble(bubble);
      setTimeout(() => setUserBubble((cur) => (cur === bubble ? null : cur)), 2400);
    }

    Animated.parallel([
      Animated.timing(userX, {
        toValue: clampedX,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(userY, {
        toValue: clampedY,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(walkBounce, { toValue: -7, duration: 130, useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: 0, duration: 130, useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: -6, duration: 130, useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: 0, duration: 130, useNativeDriver: true }),
      ]),
    ]).start();
  }

  function handleFloorTap(e: GestureResponderEvent) {
    const { locationX, locationY } = e.nativeEvent;
    walkUserTo(locationX, locationY);
  }

  function pokeCompanion() {
    const nextIdx = (lineIdx + 1) % COMPANION_LINES.length;
    setLineIdx(nextIdx);
    walkUserTo(stageSize.width * 0.54, stageSize.height * 0.50, "贴贴～");
    setCompBubble(COMPANION_LINES[nextIdx]);
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
        text: isMockMode ? "嗯，记着呢。（本地演示回复，接入模型后将按人设回应）" : "已收到。",
      },
    ]);
    setChatInput("");
  }

  const companionLeft = stageSize.width * 0.63;
  const companionTop = stageSize.height * 0.47;

  return (
    <View
      style={[
        styles.fullStage,
        { backgroundColor: roomAtmosphere === "night" ? "#26232B" : "#F3E7CE" },
      ]}
      onLayout={onStageLayout}
    >
      {/* Full-Screen Tap-to-Walk Isometric 2.5D Room */}
      <Pressable style={StyleSheet.absoluteFill} onPress={handleFloorTap}>
        <Image source={ROOM_ISO_IMG} style={styles.roomImg} resizeMode="contain" />
        {roomAtmosphere === "warm" && (
          <View pointerEvents="none" style={styles.warmOverlay} />
        )}
        {roomAtmosphere === "night" && (
          <View pointerEvents="none" style={styles.nightOverlay} />
        )}
      </Pressable>

      {/* Interactive Furniture Tap Target 1: Desk Notebook -> Secret Memo (偷窥爱意证据) */}
      <Pressable
        onPress={() => {
          walkUserTo(stageSize.width * 0.25, stageSize.height * 0.52, "偷看备忘录…");
          setTimeout(() => setActiveSheet("memo"), 360);
        }}
        style={[styles.furnitureZone, { left: "10%", top: "46%", width: 96, height: 76 }]}
        accessibilityRole="button"
        accessibilityLabel="查看书桌备忘录"
      />

      {/* Interactive Furniture Tap Target 2: Coffee Table -> Secret Wishlist */}
      <Pressable
        onPress={() => {
          walkUserTo(stageSize.width * 0.48, stageSize.height * 0.58, "看看茶几");
          setTimeout(() => setActiveSheet("wishlist"), 360);
        }}
        style={[styles.furnitureZone, { left: "44%", top: "51%", width: 96, height: 68 }]}
        accessibilityRole="button"
        accessibilityLabel="查看茶几与愿望单"
      />

      {/* Companion Chibi Character (Tap to approach & talk!) */}
      <Pressable
        onPress={pokeCompanion}
        style={[styles.actorAbs, { left: companionLeft - 28, top: companionTop - 52 }]}
        accessibilityRole="button"
        accessibilityLabel={`与${companionName}互动`}
      >
        <ChibiAvatar outfit={compOutfit} name={companionName} bubbleText={compBubble} isCompanion />
      </Pressable>

      {/* Walkable User Chibi Character */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.actorAbs,
          {
            transform: [
              { translateX: Animated.subtract(userX, 28) },
              { translateY: Animated.subtract(userY, 54) },
              { translateY: walkBounce },
            ],
          },
        ]}
      >
        <ChibiAvatar outfit={userOutfit} name={userName} bubbleText={userBubble} />
      </Animated.View>

      {/* Top-Left Minimal Hint Pill */}
      <View style={styles.topLeftPill}>
        <LiquidGlassSurface variant="chip" borderRadius={RADIUS.pill}>
          <View style={styles.hintInner}>
            <View style={[styles.hintDot, { backgroundColor: "#10B981" }]} />
            <Text style={styles.hintText}>点地板走动 · 点书桌翻备忘录</Text>
          </View>
        </LiquidGlassSurface>
      </View>

      {/* Right-Edge Slim Liquid Glass Tool Column (Never clutters the center room!) */}
      <View style={styles.edgeTools}>
        <Pressable
          onPress={() => setActiveSheet("memo")}
          style={({ pressed }) => pressed && { transform: [{ scale: 0.92 }] }}
        >
          <LiquidGlassSurface variant="chip" borderRadius={22}>
            <View style={styles.edgeBtn}>
              <Ionicons name="book-outline" size={18} color="#18181B" />
              <Text style={styles.edgeLabel}>备忘录</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>

        <Pressable
          onPress={() => setActiveSheet("wardrobe")}
          style={({ pressed }) => pressed && { transform: [{ scale: 0.92 }] }}
        >
          <LiquidGlassSurface variant="chip" borderRadius={22}>
            <View style={styles.edgeBtn}>
              <Ionicons name="shirt-outline" size={18} color="#18181B" />
              <Text style={styles.edgeLabel}>换装</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>

        <Pressable
          onPress={onOpenTimeline}
          style={({ pressed }) => pressed && { transform: [{ scale: 0.92 }] }}
        >
          <LiquidGlassSurface variant="chip" borderRadius={22}>
            <View style={styles.edgeBtn}>
              <Ionicons name="time-outline" size={18} color="#18181B" />
              <Text style={styles.edgeLabel}>{recordCount > 0 ? `记录${recordCount}` : "记录"}</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>

        <Pressable
          onPress={() => setActiveSheet("chat")}
          style={({ pressed }) => pressed && { transform: [{ scale: 0.92 }] }}
        >
          <LiquidGlassSurface variant="chip" borderRadius={22}>
            <View style={styles.edgeBtn}>
              <Ionicons name="chatbubble-ellipses-outline" size={18} color="#2563EB" />
              <Text style={[styles.edgeLabel, { color: "#2563EB" }]}>说一句</Text>
            </View>
          </LiquidGlassSurface>
        </Pressable>
      </View>

      {/* Sheets: Secret Memo / Character & Room Skin Wardrobe / Wishlist / Quick Chat */}
      <Modal
        visible={activeSheet !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActiveSheet(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActiveSheet(null)}>
          <Pressable
            style={[styles.sheetBox, { backgroundColor: skin.colors.canvas, borderColor: skin.colors.border }]}
            onPress={() => undefined}
          >
            <View style={[styles.sheetHandle, { backgroundColor: skin.colors.border }]} />

            {activeSheet === "memo" && (
              <View>
                <View style={styles.sheetHeaderRow}>
                  <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>
                    {companionName} 偷偷记下的备忘录
                  </Text>
                  {isMockMode && <Text style={styles.demoTag}>演示样例</Text>}
                </View>
                <View style={styles.memoList}>
                  <View style={[styles.memoCard, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
                    <Text style={[styles.memoText, { color: skin.colors.ink }]}>
                      • 生理期大概在下周三左右，提前提醒别喝冰美式、备点热的。
                    </Text>
                  </View>
                  <View style={[styles.memoCard, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
                    <Text style={[styles.memoText, { color: skin.colors.ink }]}>
                      • 昨晚说肩颈酸，把小家沙发靠枕换成软的了。
                    </Text>
                  </View>
                  <View style={[styles.memoCard, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
                    <Text style={[styles.memoText, { color: skin.colors.ink }]}>
                      • 路过楼下那家芋泥糖水铺多看了两眼，周末带去吃。
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => setActiveSheet(null)}
                  style={[styles.primaryBtn, { backgroundColor: skin.colors.accent }]}
                >
                  <Text style={[styles.primaryBtnText, { color: skin.colors.accentFg }]}>悄悄合上</Text>
                </Pressable>
              </View>
            )}

            {activeSheet === "wardrobe" && (
              <View>
                <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>小人与小家换装</Text>

                <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>我的小人穿搭</Text>
                <View style={styles.pillRow}>
                  {USER_OUTFITS.map((o) => {
                    const active = o.id === userOutfit.id;
                    return (
                      <Pressable
                        key={o.id}
                        onPress={() => setUserOutfit(o)}
                        style={[
                          styles.optionPill,
                          {
                            backgroundColor: active ? skin.colors.accent : skin.colors.surface,
                            borderColor: skin.colors.border,
                          },
                        ]}
                      >
                        <Text style={{ color: active ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>
                          {o.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>{companionName} 的穿搭</Text>
                <View style={styles.pillRow}>
                  {COMPANION_OUTFITS.map((o) => {
                    const active = o.id === compOutfit.id;
                    return (
                      <Pressable
                        key={o.id}
                        onPress={() => setCompOutfit(o)}
                        style={[
                          styles.optionPill,
                          {
                            backgroundColor: active ? skin.colors.accent : skin.colors.surface,
                            borderColor: skin.colors.border,
                          },
                        ]}
                      >
                        <Text style={{ color: active ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>
                          {o.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>房间光线氛围</Text>
                <View style={styles.pillRow}>
                  {([
                    { key: "day" as const, label: "清透白昼" },
                    { key: "warm" as const, label: "午后暖阳" },
                    { key: "night" as const, label: "微醺夜灯" },
                  ]).map((a) => {
                    const active = a.key === roomAtmosphere;
                    return (
                      <Pressable
                        key={a.key}
                        onPress={() => setRoomAtmosphere(a.key)}
                        style={[
                          styles.optionPill,
                          {
                            backgroundColor: active ? skin.colors.accent : skin.colors.surface,
                            borderColor: skin.colors.border,
                          },
                        ]}
                      >
                        <Text style={{ color: active ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>
                          {a.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {activeSheet === "wishlist" && (
              <View>
                <View style={styles.sheetHeaderRow}>
                  <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>茶几与共同愿望单</Text>
                  {isMockMode && <Text style={styles.demoTag}>演示样例</Text>}
                </View>
                <View style={[styles.memoCard, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
                  <Text style={[styles.memoText, { color: skin.colors.ink, fontWeight: "600" }]}>
                    奶油格纹懒人沙发（待你决定）
                  </Text>
                  <Text style={{ color: skin.colors.inkSub, fontSize: 12, marginTop: 4 }}>
                    {companionName} 备注：“放窗边一起看电影正好。”（绝不自动扣款）
                  </Text>
                </View>
                <Pressable
                  onPress={() => setActiveSheet(null)}
                  style={[styles.primaryBtn, { backgroundColor: skin.colors.accent, marginTop: 12 }]}
                >
                  <Text style={[styles.primaryBtnText, { color: skin.colors.accentFg }]}>好的</Text>
                </Pressable>
              </View>
            )}

            {activeSheet === "chat" && (
              <View>
                <View style={styles.sheetHeaderRow}>
                  <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>和 {companionName} 聊聊</Text>
                  {isMockMode && <Text style={styles.demoTag}>本地演示</Text>}
                </View>
                <ScrollView
                  style={[styles.chatStage, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}
                  contentContainerStyle={{ padding: 12 }}
                >
                  {messages.map((m) => (
                    <GlassChatBubble key={m.id} senderRole={m.role} text={m.text} />
                  ))}
                </ScrollView>
                <View style={styles.inputRow}>
                  <TextInput
                    value={chatInput}
                    onChangeText={setChatInput}
                    placeholder="跟 TA 说一句..."
                    placeholderTextColor={skin.colors.inkMute}
                    style={[
                      styles.textInput,
                      { backgroundColor: skin.colors.surface, borderColor: skin.colors.border, color: skin.colors.ink },
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
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fullStage: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  roomImg: {
    width: "100%",
    height: "100%",
  },
  warmOverlay: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: "rgba(251, 191, 36, 0.12)",
  },
  nightOverlay: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: "rgba(15, 23, 42, 0.34)",
  },
  furnitureZone: {
    position: "absolute",
    zIndex: 8,
  },
  actorAbs: {
    position: "absolute",
    zIndex: 12,
    alignItems: "center",
  },
  chibiWrap: {
    alignItems: "center",
    width: 60,
  },
  chibiSpeech: {
    position: "absolute",
    bottom: 66,
    minWidth: 74,
    maxWidth: 140,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    paddingHorizontal: 9,
    paddingVertical: 5,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  chibiSpeechText: {
    fontSize: 10.5,
    color: "#18181B",
    fontWeight: "600",
    textAlign: "center",
  },
  chibiShadow: {
    position: "absolute",
    bottom: 14,
    width: 30,
    height: 9,
    borderRadius: 5,
    backgroundColor: "rgba(40, 28, 18, 0.18)",
  },
  chibiBodyStack: {
    alignItems: "center",
  },
  chibiHead: {
    width: 30,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#FFE8D6",
    borderWidth: 2,
    borderColor: "#4A3728",
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
    zIndex: 2,
  },
  chibiHairCap: {
    position: "absolute",
    top: -3,
    left: -2,
    right: -2,
    height: 13,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
  },
  chibiBow: {
    position: "absolute",
    top: -6,
    width: 12,
    height: 7,
    borderRadius: 4,
    borderWidth: 1.2,
    borderColor: "#4A3728",
  },
  chibiEyesRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  chibiEye: {
    width: 3.5,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#2E2118",
  },
  chibiBlushRow: {
    flexDirection: "row",
    gap: 13,
    marginTop: 1,
  },
  chibiBlush: {
    width: 4.5,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: "rgba(244, 114, 148, 0.55)",
  },
  chibiTorso: {
    width: 24,
    height: 20,
    marginTop: -3,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderWidth: 2,
    borderColor: "#4A3728",
    alignItems: "center",
    zIndex: 1,
  },
  chibiCollar: {
    width: 8,
    height: 4,
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 4,
    marginTop: 1,
  },
  chibiNameTag: {
    marginTop: 2,
    backgroundColor: "rgba(255,255,255,0.88)",
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 8,
  },
  chibiNameText: {
    fontSize: 9.5,
    fontWeight: "600",
    color: "#3F3026",
  },
  topLeftPill: {
    position: "absolute",
    top: 12,
    left: 14,
    zIndex: 20,
  },
  hintInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    paddingVertical: 6,
    gap: 6,
  },
  hintDot: { width: 7, height: 7, borderRadius: 3.5 },
  hintText: { fontSize: 11, fontWeight: "600", color: "#18181B" },
  edgeTools: {
    position: "absolute",
    right: 12,
    top: 14,
    gap: 10,
    zIndex: 20,
  },
  edgeBtn: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  edgeLabel: {
    fontSize: 9.5,
    fontWeight: "600",
    color: "#18181B",
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.34)", justifyContent: "flex-end" },
  sheetBox: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    padding: 20,
    paddingBottom: 34,
  },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 14 },
  sheetHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sheetTitle: { fontSize: 17, fontWeight: "700" },
  demoTag: {
    fontSize: 10.5,
    color: "#64748B",
    backgroundColor: "#F1F5F9",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  memoList: { gap: 8, marginBottom: 14 },
  memoCard: { borderRadius: 16, borderWidth: 1, padding: 13 },
  memoText: { fontSize: 13.5, lineHeight: 20 },
  groupLabel: { fontSize: 12, fontWeight: "600", marginTop: 10, marginBottom: 8 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  chatStage: { maxHeight: 210, borderRadius: 20, borderWidth: 1, marginBottom: 12 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  textInput: { flex: 1, height: 40, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, fontSize: 13 },
  sendBtn: { height: 40, paddingHorizontal: 18, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  sendBtnText: { fontSize: 13, fontWeight: "600" },
  primaryBtn: { height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  primaryBtnText: { fontSize: 14, fontWeight: "600" },
});
