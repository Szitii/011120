import React, { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { BottomSheet } from "./BottomSheet";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { GlassChatBubble } from "./GlassChatBubble";
import { useSkin } from "../theme/SkinProvider";

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

const COMPANION_LINES = ["回来了？茶还温着。", "别光戳我，先坐会儿。", "靠枕换软了，靠着歇会儿。", "糖水铺记进备忘录了。"];

const MOCK_MEMOS = [
  "生理期大概在下周三左右，提前提醒别喝冰美式、备点热的。",
  "昨晚说肩颈酸，把小家沙发靠枕换成软的了。",
  "路过楼下那家芋泥糖水铺多看了两眼，周末带去吃。",
];

function ChibiAvatar({
  outfit,
  name,
  bubble,
  isCompanion,
}: {
  outfit: ChibiOutfit;
  name: string;
  bubble?: string | null;
  isCompanion?: boolean;
}) {
  return (
    <View style={styles.chibiWrap}>
      {bubble ? (
        <View style={styles.chibiSpeech}>
          <Text style={styles.chibiSpeechText} numberOfLines={2}>{bubble}</Text>
        </View>
      ) : null}
      <View style={styles.chibiShadow} />
      <View style={styles.chibiHead}>
        <View style={[styles.chibiHairCap, { backgroundColor: outfit.hair }]} />
        {!isCompanion && <View style={[styles.chibiBow, { backgroundColor: outfit.accent }]} />}
        <View style={styles.chibiEyes}><View style={styles.chibiEye} /><View style={styles.chibiEye} /></View>
        <View style={styles.chibiBlushes}><View style={styles.chibiBlush} /><View style={styles.chibiBlush} /></View>
      </View>
      <View style={[styles.chibiTorso, { backgroundColor: outfit.top }]}>
        <View style={[styles.chibiCollar, { backgroundColor: outfit.accent }]} />
      </View>
      <View style={styles.chibiNameTag}><Text style={styles.chibiNameText}>{name}</Text></View>
    </View>
  );
}

export function InteractiveFullRoom({
  userName,
  companionName,
  recordCount,
  onOpenTimeline,
}: {
  userName: string;
  companionName: string;
  recordCount: number;
  onOpenTimeline: () => void;
}) {
  const { skin } = useSkin();
  const [stage, setStage] = useState({ w: 390, h: 680 });
  const [userOutfit, setUserOutfit] = useState(USER_OUTFITS[0]);
  const [compOutfit, setCompOutfit] = useState(COMPANION_OUTFITS[0]);
  const [atmosphere, setAtmosphere] = useState<"day" | "warm" | "night">("day");
  const [userBubble, setUserBubble] = useState<string | null>(null);
  const [compBubble, setCompBubble] = useState<string | null>("回来了？");
  const [lineIdx, setLineIdx] = useState(0);
  const [sheet, setSheet] = useState<null | "memo" | "wardrobe" | "wishlist" | "chat">(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; role: "human" | "ai"; text: string }>>([
    { id: "m1", role: "ai", text: "靠枕换软了，回来靠着歇会儿。" },
  ]);

  const userX = useRef(new Animated.Value(120)).current;
  const userY = useRef(new Animated.Value(350)).current;
  const bounce = useRef(new Animated.Value(0)).current;

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    setStage({ w: width, h: height });
    userX.setValue(width * 0.34);
    userY.setValue(height * 0.56);
  }

  function walkTo(tx: number, ty: number, bubble?: string) {
    const cx = Math.max(stage.w * 0.16, Math.min(stage.w * 0.80, tx));
    const cy = Math.max(stage.h * 0.38, Math.min(stage.h * 0.68, ty));
    if (bubble) {
      setUserBubble(bubble);
      setTimeout(() => setUserBubble((cur) => (cur === bubble ? null : cur)), 2200);
    }
    Animated.parallel([
      Animated.timing(userX, { toValue: cx, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(userY, { toValue: cy, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(bounce, { toValue: -7, duration: 120, useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 120, useNativeDriver: true }),
        Animated.timing(bounce, { toValue: -5, duration: 120, useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 120, useNativeDriver: true }),
      ]),
    ]).start();
  }

  function sendQuickMessage(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setMessages((prev) => [
      ...prev,
      { id: `h-${Date.now()}`, role: "human", text: clean },
      { id: `a-${Date.now() + 1}`, role: "ai", text: "嗯，记着呢。（本地演示）" },
    ]);
    setChatInput("");
  }

  const edgeTools: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; color?: string; onPress: () => void }> = [
    { icon: "book-outline", label: "备忘录", onPress: () => setSheet("memo") },
    { icon: "shirt-outline", label: "换装", onPress: () => setSheet("wardrobe") },
    { icon: "time-outline", label: recordCount > 0 ? `记录${recordCount}` : "记录", onPress: onOpenTimeline },
    { icon: "chatbubble-ellipses-outline", label: "说一句", color: "#2563EB", onPress: () => setSheet("chat") },
  ];

  return (
    <View style={[styles.stage, { backgroundColor: atmosphere === "night" ? "#26232B" : "#F3E7CE" }]} onLayout={onLayout}>
      <Pressable style={styles.fill} onPress={(e: GestureResponderEvent) => walkTo(e.nativeEvent.locationX, e.nativeEvent.locationY)}>
        <Image source={ROOM_ISO_IMG} style={styles.roomImg} resizeMode="contain" />
        {atmosphere === "warm" && <View pointerEvents="none" style={styles.warmMask} />}
        {atmosphere === "night" && <View pointerEvents="none" style={styles.nightMask} />}
      </Pressable>

      {/* Desk -> Secret Memo; Coffee Table -> Wishlist */}
      <Pressable
        onPress={() => { walkTo(stage.w * 0.25, stage.h * 0.52, "偷看备忘录…"); setTimeout(() => setSheet("memo"), 320); }}
        style={[styles.zone, { left: "10%", top: "46%", width: 96, height: 76 }]}
      />
      <Pressable
        onPress={() => { walkTo(stage.w * 0.48, stage.h * 0.58, "看看茶几"); setTimeout(() => setSheet("wishlist"), 320); }}
        style={[styles.zone, { left: "44%", top: "51%", width: 96, height: 68 }]}
      />

      {/* Companion Chibi */}
      <Pressable
        onPress={() => {
          const next = (lineIdx + 1) % COMPANION_LINES.length;
          setLineIdx(next);
          walkTo(stage.w * 0.54, stage.h * 0.50, "贴贴～");
          setCompBubble(COMPANION_LINES[next]);
        }}
        style={[styles.actor, { left: stage.w * 0.63 - 28, top: stage.h * 0.47 - 52 }]}
      >
        <ChibiAvatar outfit={compOutfit} name={companionName} bubble={compBubble} isCompanion />
      </Pressable>

      {/* Walkable User Chibi */}
      <Animated.View
        pointerEvents="none"
        style={[styles.actor, { transform: [{ translateX: Animated.subtract(userX, 28) }, { translateY: Animated.subtract(userY, 54) }, { translateY: bounce }] }]}
      >
        <ChibiAvatar outfit={userOutfit} name={userName} bubble={userBubble} />
      </Animated.View>

      <View style={styles.hintPill}>
        <LiquidGlassSurface>
          <View style={styles.hintInner}>
            <View style={styles.hintDot} />
            <Text style={styles.hintText}>点地板走动 · 点书桌翻备忘录</Text>
          </View>
        </LiquidGlassSurface>
      </View>

      <View style={styles.edgeTools}>
        {edgeTools.map((t) => (
          <Pressable key={t.label} onPress={t.onPress} style={({ pressed }) => pressed && { transform: [{ scale: 0.92 }] }}>
            <LiquidGlassSurface borderRadius={22}>
              <View style={styles.edgeBtn}>
                <Ionicons name={t.icon} size={18} color={t.color ?? "#18181B"} />
                <Text style={[styles.edgeLabel, t.color ? { color: t.color } : null]}>{t.label}</Text>
              </View>
            </LiquidGlassSurface>
          </Pressable>
        ))}
      </View>

      <BottomSheet
        visible={sheet === "memo"}
        title={`${companionName} 偷偷记下的备忘录`}
        badge={"演示样例"}
        onClose={() => setSheet(null)}
      >
        <View style={styles.stackGap}>
          {(MOCK_MEMOS).map((m, i) => (
            <View key={i} style={[styles.card, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
              <Text style={[styles.cardText, { color: skin.colors.ink }]}>• {m}</Text>
            </View>
          ))}
        </View>
        <Pressable onPress={() => setSheet(null)} style={[styles.primaryBtn, { backgroundColor: skin.colors.accent }]}>
          <Text style={[styles.primaryText, { color: skin.colors.accentFg }]}>悄悄合上</Text>
        </Pressable>
      </BottomSheet>

      <BottomSheet visible={sheet === "wardrobe"} title="小人与小家换装" onClose={() => setSheet(null)}>
        <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>我的小人穿搭</Text>
        <View style={styles.pillRow}>
          {USER_OUTFITS.map((o) => (
            <Pressable
              key={o.id}
              onPress={() => setUserOutfit(o)}
              style={[styles.pill, { backgroundColor: o.id === userOutfit.id ? skin.colors.accent : skin.colors.surface, borderColor: skin.colors.border }]}
            >
              <Text style={{ color: o.id === userOutfit.id ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>{companionName} 的穿搭</Text>
        <View style={styles.pillRow}>
          {COMPANION_OUTFITS.map((o) => (
            <Pressable
              key={o.id}
              onPress={() => setCompOutfit(o)}
              style={[styles.pill, { backgroundColor: o.id === compOutfit.id ? skin.colors.accent : skin.colors.surface, borderColor: skin.colors.border }]}
            >
              <Text style={{ color: o.id === compOutfit.id ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.groupLabel, { color: skin.colors.inkSub }]}>房间光线</Text>
        <View style={styles.pillRow}>
          {([{ k: "day" as const, l: "清透白昼" }, { k: "warm" as const, l: "午后暖阳" }, { k: "night" as const, l: "微醺夜灯" }]).map((a) => (
            <Pressable
              key={a.k}
              onPress={() => setAtmosphere(a.k)}
              style={[styles.pill, { backgroundColor: a.k === atmosphere ? skin.colors.accent : skin.colors.surface, borderColor: skin.colors.border }]}
            >
              <Text style={{ color: a.k === atmosphere ? skin.colors.accentFg : skin.colors.ink, fontSize: 12.5, fontWeight: "600" }}>{a.l}</Text>
            </Pressable>
          ))}
        </View>
      </BottomSheet>

      <BottomSheet visible={sheet === "wishlist"} title="共同愿望单" badge={"演示样例"} onClose={() => setSheet(null)}>
        <View style={[styles.card, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border, marginBottom: 14 }]}>
          <Text style={[styles.cardText, { color: skin.colors.ink, fontWeight: "600" }]}>奶油格纹懒人沙发（待你决定）</Text>
          <Text style={{ color: skin.colors.inkSub, fontSize: 12, marginTop: 4 }}>{companionName} 备注：“放窗边一起看电影正好。”</Text>
        </View>
        <Pressable onPress={() => setSheet(null)} style={[styles.primaryBtn, { backgroundColor: skin.colors.accent }]}>
          <Text style={[styles.primaryText, { color: skin.colors.accentFg }]}>好的</Text>
        </Pressable>
      </BottomSheet>

      <BottomSheet visible={sheet === "chat"} title={`和 ${companionName} 聊聊`} badge={"本地演示"} onClose={() => setSheet(null)}>
        <ScrollView style={[styles.chatStage, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]} contentContainerStyle={{ padding: 12 }}>
          {messages.map((m) => <GlassChatBubble key={m.id} senderRole={m.role} text={m.text} />)}
        </ScrollView>
        <View style={styles.inputRow}>
          <TextInput
            value={chatInput}
            onChangeText={setChatInput}
            placeholder="说一句..."
            placeholderTextColor={skin.colors.inkMute}
            style={[styles.input, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border, color: skin.colors.ink }]}
            returnKeyType="send"
            onSubmitEditing={() => sendQuickMessage(chatInput)}
          />
          <Pressable onPress={() => sendQuickMessage(chatInput)} style={[styles.sendBtn, { backgroundColor: skin.colors.accent }]}>
            <Text style={{ color: skin.colors.accentFg, fontSize: 13, fontWeight: "600" }}>发送</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, position: "relative", overflow: "hidden" },
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  roomImg: { width: "100%", height: "100%" },
  warmMask: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(251,191,36,0.12)" },
  nightMask: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(15,23,42,0.34)" },
  zone: { position: "absolute", zIndex: 8 },
  actor: { position: "absolute", zIndex: 12, alignItems: "center" },
  chibiWrap: { alignItems: "center", width: 60 },
  chibiSpeech: {
    position: "absolute", bottom: 66, minWidth: 74, maxWidth: 140,
    backgroundColor: "rgba(255,255,255,0.95)", borderRadius: 14, borderWidth: 1, borderColor: "#E2E8F0",
    paddingHorizontal: 9, paddingVertical: 5,
  },
  chibiSpeechText: { fontSize: 10.5, color: "#18181B", fontWeight: "600", textAlign: "center" },
  chibiShadow: { position: "absolute", bottom: 14, width: 30, height: 9, borderRadius: 5, backgroundColor: "rgba(40,28,18,0.18)" },
  chibiHead: { width: 30, height: 28, borderRadius: 14, backgroundColor: "#FFE8D6", borderWidth: 2, borderColor: "#4A3728", alignItems: "center", justifyContent: "center", zIndex: 2 },
  chibiHairCap: { position: "absolute", top: -3, left: -2, right: -2, height: 13, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 6, borderBottomRightRadius: 6 },
  chibiBow: { position: "absolute", top: -6, width: 12, height: 7, borderRadius: 4, borderWidth: 1.2, borderColor: "#4A3728" },
  chibiEyes: { flexDirection: "row", gap: 8, marginTop: 6 },
  chibiEye: { width: 3.5, height: 4, borderRadius: 2, backgroundColor: "#2E2118" },
  chibiBlushes: { flexDirection: "row", gap: 13, marginTop: 1 },
  chibiBlush: { width: 4.5, height: 2.5, borderRadius: 2, backgroundColor: "rgba(244,114,148,0.55)" },
  chibiTorso: { width: 24, height: 20, marginTop: -3, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 7, borderBottomRightRadius: 7, borderWidth: 2, borderColor: "#4A3728", alignItems: "center", zIndex: 1 },
  chibiCollar: { width: 8, height: 4, borderBottomLeftRadius: 4, borderBottomRightRadius: 4, marginTop: 1 },
  chibiNameTag: { marginTop: 2, backgroundColor: "rgba(255,255,255,0.88)", paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 8 },
  chibiNameText: { fontSize: 9.5, fontWeight: "600", color: "#3F3026" },
  hintPill: { position: "absolute", top: 12, left: 14, zIndex: 20 },
  hintInner: { flexDirection: "row", alignItems: "center", paddingHorizontal: 11, paddingVertical: 6, gap: 6 },
  hintDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: "#10B981" },
  hintText: { fontSize: 11, fontWeight: "600", color: "#18181B" },
  edgeTools: { position: "absolute", right: 12, top: 14, gap: 10, zIndex: 20 },
  edgeBtn: { width: 46, height: 46, alignItems: "center", justifyContent: "center", gap: 2 },
  edgeLabel: { fontSize: 9.5, fontWeight: "600", color: "#18181B" },
  stackGap: { gap: 8, marginBottom: 14 },
  card: { borderRadius: 16, borderWidth: 1, padding: 13 },
  cardText: { fontSize: 13.5, lineHeight: 20 },
  groupLabel: { fontSize: 12, fontWeight: "600", marginTop: 10, marginBottom: 8 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  chatStage: { maxHeight: 200, borderRadius: 20, borderWidth: 1, marginBottom: 12 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, height: 40, borderRadius: 999, borderWidth: 1, paddingHorizontal: 14, fontSize: 13 },
  sendBtn: { height: 40, paddingHorizontal: 18, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  primaryBtn: { height: 44, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 14, fontWeight: "600" },
});
