import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useTransientBubble } from "./useTransientBubble";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { PEARL_UI } from "../theme/skinTokens";
import { RADIUS } from "../theme/layoutTokens";

const ROOM_PEARL_IMG = require("../../assets/room-pearl.webp");
const SPRITE_OWNER = require("../../assets/sprite-owner.png");
const SPRITE_COMPANION = require("../../assets/sprite-companion.png");

const COMPANION_WHISPERS = [
  "今晚风大，回来喝杯热的。",
  "靠枕换软了，过来歇会儿。",
  "贴贴～今天辛苦啦。",
  "刚把你喜欢的歌放进歌单了。",
  "窗台的小黑猫刚睡着呢。",
];

interface FloatingHeart {
  id: number;
  x: number;
  y: number;
  anim: Animated.Value;
}

export function PearlInteractiveRoom({
  userName,
  companionName,
  isCompanionView,
}: {
  userName: string;
  companionName: string;
  isCompanionView: boolean;
}) {
  const [stage, setStage] = useState({ w: 340, h: 288 });
  const [nightMode, setNightMode] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [userBubble, setUserBubble] = useTransientBubble();
  const [compBubble, setCompBubble] = useTransientBubble();
  const [whisperIndex, setWhisperIndex] = useState(0);
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);

  const userX = useRef(new Animated.Value(204)).current;
  const userY = useRef(new Animated.Value(174)).current;
  const walkBounce = useRef(new Animated.Value(0)).current;
  const idleFloatA = useRef(new Animated.Value(0)).current;
  const idleFloatB = useRef(new Animated.Value(0)).current;
  const compPop = useRef(new Animated.Value(1)).current;
  const rippleScale = useRef(new Animated.Value(0)).current;
  const rippleOpacity = useRef(new Animated.Value(0)).current;
  const [ripplePos, setRipplePos] = useState({ x: 0, y: 0 });
  const currentPosRef = useRef({ x: 204, y: 174 });
  const heartIdRef = useRef(0);
  const walkAnimation = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(idleFloatA, {
          toValue: -2.5,
          duration: 1300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(idleFloatA, {
          toValue: 0,
          duration: 1300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(idleFloatB, {
          toValue: -2,
          duration: 1550,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(idleFloatB, {
          toValue: 0,
          duration: 1550,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loopA.start();
    loopB.start();
    return () => {
      loopA.stop();
      loopB.stop();
      walkAnimation.current?.stop();
    };
  }, [idleFloatA, idleFloatB]);

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setStage({ w: width, h: height });
    const startX = width * 0.62;
    const startY = height * 0.62;
    currentPosRef.current = { x: startX, y: startY };
    userX.setValue(startX);
    userY.setValue(startY);
  }

  function spawnHeart(x: number, y: number) {
    const id = ++heartIdRef.current;
    const anim = new Animated.Value(0);
    setHearts((prev) => [...prev.slice(-4), { id, x, y, anim }]);
    Animated.timing(anim, {
      toValue: 1,
      duration: 950,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setHearts((prev) => prev.filter((h) => h.id !== id));
    });
  }

  function triggerRipple(x: number, y: number) {
    setRipplePos({ x, y });
    rippleScale.setValue(0.3);
    rippleOpacity.setValue(0.85);
    Animated.parallel([
      Animated.timing(rippleScale, {
        toValue: 1.5,
        duration: 460,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(rippleOpacity, {
        toValue: 0,
        duration: 460,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }

  function popCompanionWhisper(customUserBubble?: string) {
    const next = (whisperIndex + 1) % COMPANION_WHISPERS.length;
    setWhisperIndex(next);
    setCompBubble(COMPANION_WHISPERS[next]);
    if (customUserBubble) setUserBubble(customUserBubble);
    Animated.sequence([
      Animated.spring(compPop, { toValue: 1.1, speed: 28, bounciness: 10, useNativeDriver: true }),
      Animated.spring(compPop, { toValue: 1, speed: 22, bounciness: 8, useNativeDriver: true }),
    ]).start();
    spawnHeart(stage.w * 0.38, stage.h * 0.44);
  }

  function walkTo(tx: number, ty: number, bubble?: string) {
    setHasInteracted(true);
    const clampedX = Math.max(stage.w * 0.14, Math.min(stage.w * 0.86, tx));
    const clampedY = Math.max(stage.h * 0.48, Math.min(stage.h * 0.84, ty));
    const dx = clampedX - currentPosRef.current.x;
    const dy = clampedY - currentPosRef.current.y;
    const dist = Math.hypot(dx, dy);
    if (Math.abs(dx) > 4) setFacingLeft(dx < 0);
    currentPosRef.current = { x: clampedX, y: clampedY };
    triggerRipple(clampedX, clampedY);

    const duration = Math.max(300, Math.min(680, Math.round(dist * 2.6)));
    if (bubble) setUserBubble(bubble);

    walkAnimation.current?.stop();
    walkAnimation.current = Animated.parallel([
      Animated.timing(userX, {
        toValue: clampedX,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(userY, {
        toValue: clampedY,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(walkBounce, { toValue: -7, duration: Math.round(duration * 0.25), useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: 0, duration: Math.round(duration * 0.25), useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: -5, duration: Math.round(duration * 0.25), useNativeDriver: true }),
        Animated.timing(walkBounce, { toValue: 0, duration: Math.round(duration * 0.25), useNativeDriver: true }),
      ]),
    ]);
    walkAnimation.current.start(({ finished }) => {
      if (!finished) return;
      const compX = stage.w * 0.36;
      const compY = stage.h * 0.58;
      if (bubble || Math.hypot(clampedX - compX, clampedY - compY) < 88) {
        popCompanionWhisper();
      }
    });
  }

  function handleSnuggle() {
    walkTo(stage.w * 0.49, stage.h * 0.60, "贴贴～");
  }

  const companionLeft = stage.w * 0.36 - 34;
  const companionTop = stage.h * 0.58 - 70;
  const actorLeftName = isCompanionView ? userName : companionName;
  const actorRightName = isCompanionView ? "本人" : userName;

  return (
    <View style={styles.frame} onLayout={onLayout}>
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityLabel="点击小家地板走动"
        onPress={(e: GestureResponderEvent) => walkTo(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      >
        <Image source={ROOM_PEARL_IMG} style={styles.roomImg} resizeMode="cover" />

        {nightMode && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={styles.nightVeil} />
            <View style={styles.lampGlowLeft} />
            <View style={styles.lampGlowCenter} />
          </View>
        )}
      </Pressable>

      {/* Tap ripple ring */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.ripple,
          {
            left: ripplePos.x - 14,
            top: ripplePos.y - 8,
            opacity: rippleOpacity,
            transform: [{ scale: rippleScale }],
          },
        ]}
      />

      {/* Companion Pixel Sprite */}
      <Pressable
        onPress={() => {
          setHasInteracted(true);
          popCompanionWhisper("戳你一下～");
        }}
        style={[styles.spriteSlot, { left: companionLeft, top: companionTop }]}
        accessibilityRole="button"
        accessibilityLabel={`与 ${actorLeftName} 互动`}
      >
        {compBubble ? (
          <View style={styles.speechBubble}>
            <Text style={styles.speechText} numberOfLines={2}>{compBubble}</Text>
          </View>
        ) : null}
        <Animated.View style={{ alignItems: "center", transform: [{ translateY: idleFloatB }, { scale: compPop }] }}>
          <View style={styles.spriteShadow} />
          <Image source={SPRITE_COMPANION} style={styles.spriteImg} resizeMode="contain" />
        </Animated.View>
        <View style={styles.nameChip}>
          <Text style={styles.nameChipText} numberOfLines={1}>{actorLeftName}</Text>
        </View>
      </Pressable>

      {/* Walkable User Pixel Sprite */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.spriteSlot,
          {
            transform: [
              { translateX: Animated.subtract(userX, 34) },
              { translateY: Animated.subtract(userY, 72) },
              { translateY: walkBounce },
              { translateY: idleFloatA },
            ],
          },
        ]}
      >
        {userBubble ? (
          <View style={[styles.speechBubble, styles.speechBubbleUser]}>
            <Text style={[styles.speechText, styles.speechTextUser]} numberOfLines={1}>{userBubble}</Text>
          </View>
        ) : null}
        <View style={styles.spriteShadow} />
        <Image
          source={SPRITE_OWNER}
          style={[styles.spriteImg, facingLeft && { transform: [{ scaleX: -1 }] }]}
          resizeMode="contain"
        />
        <View style={styles.nameChip}>
          <Text style={styles.nameChipText} numberOfLines={1}>{actorRightName}</Text>
        </View>
      </Animated.View>

      {/* Floating Hearts */}
      {hearts.map((h) => (
        <Animated.View
          key={h.id}
          pointerEvents="none"
          style={[
            styles.heartWrap,
            {
              left: h.x,
              top: h.y,
              opacity: h.anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateY: h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -34] }) },
                { scale: h.anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 1.15, 0.9] }) },
              ],
            },
          ]}
        >
          <Ionicons name="heart" size={14} color="#C87D87" />
        </Animated.View>
      ))}

      {/* Subtle top-left hint (fades after interaction) */}
      {!hasInteracted && (
        <View pointerEvents="none" style={styles.topLeftOverlay}>
          <LiquidGlassSurface glass borderRadius={RADIUS.pill}>
            <View style={styles.hintInner}>
              <View style={styles.liveDot} />
              <Text style={styles.hintText}>点房间走动 · 点 TA 贴贴</Text>
            </View>
          </LiquidGlassSurface>
        </View>
      )}

      {/* Top-right Day/Night ambient light toggle */}
      <Pressable
        onPress={() => setNightMode((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel="切换昼夜光线"
        style={({ pressed }) => [styles.topRightOverlay, pressed && { transform: [{ scale: 0.92 }] }]}
      >
        <LiquidGlassSurface glass tint={nightMode ? "dark" : "light"} borderRadius={RADIUS.pill}>
          <View style={styles.modeBtn}>
            <Ionicons
              name={nightMode ? "moon" : "sunny-outline"}
              size={15}
              color={nightMode ? "#FDE68A" : PEARL_UI.accentInk}
            />
          </View>
        </LiquidGlassSurface>
      </Pressable>

      {/* Bottom-left quick Snuggle pill */}
      <Pressable
        onPress={handleSnuggle}
        accessibilityRole="button"
        accessibilityLabel="贴贴"
        style={({ pressed }) => [styles.bottomLeftOverlay, pressed && { transform: [{ scale: 0.94 }] }]}
      >
        <LiquidGlassSurface glass tint={nightMode ? "dark" : "light"} borderRadius={RADIUS.pill}>
          <View style={styles.snuggleInner}>
            <Ionicons name="heart-outline" size={13} color={nightMode ? "#F9A8D4" : "#C87D87"} />
            <Text style={[styles.snuggleText, nightMode && { color: "#F8FAFC" }]}>贴贴</Text>
          </View>
        </LiquidGlassSurface>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    aspectRatio: 1.18,
    borderRadius: RADIUS.roomFrame,
    borderWidth: 1.5,
    borderColor: PEARL_UI.highlight,
    backgroundColor: PEARL_UI.background[1],
    overflow: "hidden",
    shadowColor: "#8A857C",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 3,
  },
  roomImg: {
    width: "100%",
    height: "100%",
  },
  nightVeil: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: "rgba(24, 30, 52, 0.30)",
  },
  lampGlowLeft: {
    position: "absolute",
    left: "2%",
    bottom: "4%",
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: "rgba(255, 214, 140, 0.22)",
  },
  lampGlowCenter: {
    position: "absolute",
    left: "34%",
    top: "12%",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(255, 224, 160, 0.18)",
  },
  ripple: {
    position: "absolute",
    width: 28,
    height: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.9)",
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    zIndex: 6,
  },
  spriteSlot: {
    position: "absolute",
    width: 68,
    alignItems: "center",
    zIndex: 12,
  },
  spriteShadow: {
    position: "absolute",
    bottom: 2,
    width: 34,
    height: 9,
    borderRadius: 5,
    backgroundColor: "rgba(42, 34, 28, 0.18)",
  },
  spriteImg: {
    width: 58,
    height: 82,
  },
  nameChip: {
    marginTop: 2,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.84)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.95)",
  },
  nameChipText: {
    fontSize: 9.5,
    fontWeight: "600",
    color: PEARL_UI.ink,
    maxWidth: 64,
  },
  speechBubble: {
    position: "absolute",
    bottom: 98,
    minWidth: 92,
    maxWidth: 156,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.98)",
    shadowColor: "#5C544B",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 2,
  },
  speechBubbleUser: {
    backgroundColor: "rgba(123, 144, 172, 0.92)",
    borderColor: "rgba(255, 255, 255, 0.6)",
  },
  speechText: {
    fontSize: 10.5,
    lineHeight: 14.5,
    fontWeight: "600",
    color: PEARL_UI.ink,
    textAlign: "center",
  },
  speechTextUser: {
    color: "#FFFFFF",
  },
  heartWrap: {
    position: "absolute",
    zIndex: 20,
  },
  topLeftOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 18,
  },
  hintInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 5,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#C87D87",
  },
  hintText: {
    fontSize: 10.5,
    fontWeight: "600",
    color: PEARL_UI.ink,
  },
  topRightOverlay: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 18,
  },
  modeBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomLeftOverlay: {
    position: "absolute",
    bottom: 12,
    left: 12,
    zIndex: 18,
  },
  snuggleInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    paddingVertical: 6,
    gap: 4,
  },
  snuggleText: {
    fontSize: 11,
    fontWeight: "600",
    color: PEARL_UI.ink,
  },
});
