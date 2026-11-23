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
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { PearlTransitionLoader } from "./PearlTransitionLoader";
import { PEARL_UI } from "../theme/skinTokens";
import { RADIUS } from "../theme/layoutTokens";
import {
  BED_QUILT_OVERLAY,
  BOY_SPRITES,
  DUO_SPRITES,
  GIRL_SPRITES,
  ROOM_BASE_IMAGE,
  ROOM_SLOTS,
  type CharacterAction,
} from "../room/roomSlots";

import { findSafePath, type RoomPoint } from "../room/pathfinding";
import { useAppIsActive } from "../state/useAppIsActive";

import type { CompanionAction } from "../../../contracts/companion-actions.ts";

const DUO_BASELINE = 0.84;
const DUO_CENTER = 0.525;
const DUO_ACTIONS = ["PAT_HEAD", "HUG", "CUDDLE"] as const;
const COMPANION_MENU = [["WAVE", "挥手"], ["PAT_HEAD", "摸头"], ["HUG", "抱抱"], ["CUDDLE", "贴贴"]] as const;

interface FloatingHeart {
  id: number;
  x: number;
  y: number;
  anim: Animated.Value;
}

type SeatKind = "none" | "sofa" | "bed";

function actionForSeat(seat: SeatKind): CharacterAction {
  return seat === "bed" ? "sleep" : seat === "sofa" ? "sit" : "idle";
}

const WALK_FRAMES: CharacterAction[] = ["walk_1", "walk_2", "walk_3", "walk_4"];
// Base room + all slots + both characters' idle sprites
const TOTAL_ROOM_ASSETS = 1 + ROOM_SLOTS.length + 2;

export function PearlInteractiveRoom({
  companionName,
  isCompanionView,
  isActive = true,
  onAction,
  onOpenDiary,
}: {
  companionName: string;
  isCompanionView: boolean;
  isActive?: boolean;
  onAction?: (action: CompanionAction) => void;
  onOpenDiary?: () => void;
}) {
  const [stage, setStage] = useState({ w: 344, h: 430 });
  const [nightMode, setNightMode] = useState(false);
  const [roomReady, setRoomReady] = useState(false);
  const [userFacingLeft, setUserFacingLeft] = useState(false);
  const [compFacingLeft, setCompFacingLeft] = useState(false);
  const [userAction, setUserAction] = useState<CharacterAction>("idle");
  const [compAction, setCompAction] = useState<CharacterAction>("idle");
  const [userSortY, setUserSortY] = useState(0.46);
  const [compSortY, setCompSortY] = useState(0.46);
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);
  const [companionMenuOpen, setCompanionMenuOpen] = useState(false);
  const [duo, setDuo] = useState<{ action: keyof typeof DUO_SPRITES; frame: number }>();
  const duoEpoch = useRef(0);
  const duoActive = useRef(false);
  const duoTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const waveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const zzzAnim = useRef(new Animated.Value(0)).current;

  // Persistent normalized positions (preserved across onLayout & tab switches!)
  const userNormRef = useRef({ nx: 0.60, ny: 0.46 });
  const compNormRef = useRef({ nx: 0.46, ny: 0.46 });
  const userSeatRef = useRef<SeatKind>("none");
  const compSeatRef = useRef<SeatKind>("none");
  const stageRef = useRef({ w: 344, h: 430 });

  const userX = useRef(new Animated.Value(206)).current;
  const userY = useRef(new Animated.Value(198)).current;
  const compX = useRef(new Animated.Value(158)).current;
  const compY = useRef(new Animated.Value(198)).current;

  const idleFloatA = useRef(new Animated.Value(0)).current;
  const idleFloatB = useRef(new Animated.Value(0)).current;
  const roomReveal = useRef(new Animated.Value(0)).current;
  const userFade = useRef(new Animated.Value(1)).current;
  const compFade = useRef(new Animated.Value(1)).current;
  const companionReact = useRef(new Animated.Value(0)).current;
  const petBounce = useRef(new Animated.Value(1)).current;
  const diaryBounce = useRef(new Animated.Value(1)).current;
  const modeSpin = useRef(new Animated.Value(0)).current;

  const rippleScale = useRef(new Animated.Value(0)).current;
  const rippleOpacity = useRef(new Animated.Value(0)).current;
  const rippleOuterScale = useRef(new Animated.Value(0)).current;
  const rippleOuterOpacity = useRef(new Animated.Value(0)).current;
  const [ripplePos, setRipplePos] = useState({ x: 0, y: 0 });

  const loadedIdsRef = useRef<Set<string>>(new Set());
  const lastUserZRef = useRef(46);
  const lastCompZRef = useRef(46);
  const appActive = useAppIsActive();
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heartAnimations = useRef(new Map<number, Animated.CompositeAnimation>()).current;
  const mountedAtRef = useRef(Date.now());
  const heartIdRef = useRef(0);
  const userTokenRef = useRef(0);
  const compTokenRef = useRef(0);
  const userAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const compAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const userWalkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compWalkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track real-time animated coordinates so interrupting mid-walk re-plans from actual live spot
  useEffect(() => {
    const uxId = userX.addListener(({ value }) => {
      userNormRef.current.nx = value / Math.max(1, stageRef.current.w);
    });
    const uyId = userY.addListener(({ value }) => {
      const ny = value / Math.max(1, stageRef.current.h);
      userNormRef.current.ny = ny;
      const z = Math.round(ny * 100);
      if (z !== lastUserZRef.current) {
        lastUserZRef.current = z;
        setUserSortY(ny);
      }
    });
    const cxId = compX.addListener(({ value }) => {
      compNormRef.current.nx = value / Math.max(1, stageRef.current.w);
    });
    const cyId = compY.addListener(({ value }) => {
      const ny = value / Math.max(1, stageRef.current.h);
      compNormRef.current.ny = ny;
      const z = Math.round(ny * 100);
      if (z !== lastCompZRef.current) {
        lastCompZRef.current = z;
        setCompSortY(ny);
      }
    });
    return () => {
      userX.removeListener(uxId);
      userY.removeListener(uyId);
      compX.removeListener(cxId);
      compY.removeListener(cyId);
    };
  }, [userX, userY, compX, compY]);

  function markAssetLoaded(assetId: string) {
    if (loadedIdsRef.current.has(assetId)) return;
    loadedIdsRef.current.add(assetId);
    if (loadedIdsRef.current.size >= TOTAL_ROOM_ASSETS && !roomReady) {
      const elapsed = Date.now() - mountedAtRef.current;
      const wait = Math.max(0, 200 - elapsed);
      clearTimeout(readyTimer.current);
      readyTimer.current = setTimeout(() => setRoomReady(true), wait);
    }
  }

  useEffect(() => {
    readyTimer.current = setTimeout(() => setRoomReady(true), 760);
    return () => clearTimeout(readyTimer.current);
  }, []);

  useEffect(() => {
    if (!roomReady) return;
    const reveal = Animated.timing(roomReveal, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    reveal.start();
    return () => reveal.stop();
  }, [roomReady, roomReveal]);

  const someoneSleeping = userAction === "sleep" || compAction === "sleep";

  useEffect(() => {
    if (!isActive || !appActive || !someoneSleeping) return;
    const zzzLoop = Animated.loop(
      Animated.timing(zzzAnim, {
        toValue: 1,
        duration: 2400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    zzzLoop.start();
    return () => zzzLoop.stop();
  }, [isActive, appActive, someoneSleeping, zzzAnim]);

  function stopRoomMotion() {
    duoEpoch.current++;
    duoActive.current = false;
    clearInterval(duoTimer.current);
    clearTimeout(waveTimer.current);
    setDuo(undefined);
    setCompanionMenuOpen(false);
    userTokenRef.current++;
    compTokenRef.current++;
    userAnimRef.current?.stop();
    compAnimRef.current?.stop();
    stopWalkCycle(userWalkTimerRef);
    stopWalkCycle(compWalkTimerRef);
    userFade.setValue(1);
    compFade.setValue(1);
    setUserAction(actionForSeat(userSeatRef.current));
    setCompAction(actionForSeat(compSeatRef.current));
    companionReact.stopAnimation();
    companionReact.setValue(0);
  }

  // Pause idle loops and movement when the room leaves the foreground.
  useEffect(() => {
    if (!isActive || !appActive) {
      stopRoomMotion();
      stopHearts();
      setHearts([]);
      return;
    }
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(idleFloatA, {
          toValue: -1.6,
          duration: 1450,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(idleFloatA, {
          toValue: 0,
          duration: 1450,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(idleFloatB, {
          toValue: -1.5,
          duration: 1700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(idleFloatB, {
          toValue: 0,
          duration: 1700,
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
    };
  }, [isActive, appActive, idleFloatA, idleFloatB, userFade, compFade, companionReact]);

  useEffect(() => {
    return () => {
      stopHearts();
      userTokenRef.current++;
      compTokenRef.current++;
      duoEpoch.current++;
      clearInterval(duoTimer.current);
      clearTimeout(waveTimer.current);
      userAnimRef.current?.stop();
      compAnimRef.current?.stop();
      if (userWalkTimerRef.current) clearInterval(userWalkTimerRef.current);
      if (compWalkTimerRef.current) clearInterval(compWalkTimerRef.current);
    };
  }, []);

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0 || (width === stageRef.current.w && height === stageRef.current.h)) return;
    stopRoomMotion();
    stageRef.current = { w: width, h: height };
    setStage({ w: width, h: height });
    // Restore preserved normalized coordinates instead of resetting positions!
    compX.setValue(compNormRef.current.nx * width);
    compY.setValue(compNormRef.current.ny * height);
    userX.setValue(userNormRef.current.nx * width);
    userY.setValue(userNormRef.current.ny * height);
  }

  function stopHearts() {
    const animations = [...heartAnimations.values()];
    heartAnimations.clear();
    animations.forEach(animation => animation.stop());
  }

  function spawnHeart(x: number, y: number) {
    const id = ++heartIdRef.current;
    const anim = new Animated.Value(0);
    setHearts((prev) => [...prev.slice(-5), { id, x, y, anim }]);
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: 950,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    heartAnimations.set(id, animation);
    animation.start(() => {
      if (heartAnimations.delete(id)) setHearts((prev) => prev.filter((h) => h.id !== id));
    });
  }

  function triggerRipple(x: number, y: number) {
    setRipplePos({ x, y });
    rippleScale.setValue(0.28);
    rippleOpacity.setValue(0.88);
    rippleOuterScale.setValue(0.2);
    rippleOuterOpacity.setValue(0.58);
    Animated.parallel([
      Animated.timing(rippleScale, {
        toValue: 1.45,
        duration: 440,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(rippleOpacity, {
        toValue: 0,
        duration: 440,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(rippleOuterScale, {
        toValue: 2.1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(rippleOuterOpacity, {
        toValue: 0,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }

  function bounceAnim(val: Animated.Value) {
    val.setValue(0.88);
    Animated.spring(val, {
      toValue: 1,
      speed: 20,
      bounciness: 12,
      useNativeDriver: true,
    }).start();
  }

  function startWalkCycle(
    timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>,
    setter: (a: CharacterAction) => void,
  ) {
    if (timerRef.current) clearInterval(timerRef.current);
    let idx = 0;
    setter(WALK_FRAMES[0]);
    timerRef.current = setInterval(() => {
      idx = (idx + 1) % WALK_FRAMES.length;
      setter(WALK_FRAMES[idx]);
    }, 160);
  }

  function stopWalkCycle(timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>) {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  type Actor = "user" | "companion";

  function furnitureEntrance(who: Actor, seat: SeatKind): RoomPoint {
    if (seat === "bed") return who === "user" ? { nx: 0.42, ny: 0.47 } : { nx: 0.39, ny: 0.47 };
    // Reach the open front corners beside the coffee table before sitting.
    return { nx: who === "user" ? 0.78 : 0.38, ny: 0.71 };
  }

  function planMove(who: Actor, target: RoomPoint, seat: SeatKind, exact = false) {
    const isUser = who === "user";
    const currentSeat = (isUser ? userSeatRef : compSeatRef).current;
    const start = currentSeat === "none"
      ? (isUser ? userNormRef : compNormRef).current
      : furnitureEntrance(who, currentSeat);
    const end = seat === "none" ? target : furnitureEntrance(who, seat);
    const sameSeat = currentSeat === seat && seat !== "none";
    const path = sameSeat ? [] : findSafePath(start, end, exact || seat !== "none");
    return path ? { currentSeat, start, end, sameSeat, path } : undefined;
  }

  function moveCharacterAlong(
    who: Actor, target: RoomPoint, seat: SeatKind = "none",
    feedback?: "ripple", plan = planMove(who, target, seat), onArrival?: () => void,
  ) {
    if (!plan) return;
    const { currentSeat, start, end, sameSeat, path } = plan;
    const isUser = who === "user";
    const tokenRef = isUser ? userTokenRef : compTokenRef;
    const animRef = isUser ? userAnimRef : compAnimRef;
    const walkTimerRef = isUser ? userWalkTimerRef : compWalkTimerRef;
    const normRef = isUser ? userNormRef : compNormRef;
    const seatRef = isUser ? userSeatRef : compSeatRef;
    const x = isUser ? userX : compX;
    const y = isUser ? userY : compY;
    const fade = isUser ? userFade : compFade;
    const setAction = isUser ? setUserAction : setCompAction;
    const setFacing = isUser ? setUserFacingLeft : setCompFacingLeft;
    const token = ++tokenRef.current;
    animRef.current?.stop();
    stopWalkCycle(walkTimerRef);
    fade.setValue(1);
    const current = () => tokenRef.current === token;
    const play = (animation: Animated.CompositeAnimation, done: () => void) => {
      animRef.current = animation;
      animation.start(({ finished }) => {
        if (finished && current()) done();
      });
    };
    const place = (point: RoomPoint) => {
      normRef.current = { ...point };
      x.setValue(point.nx * stageRef.current.w);
      y.setValue(point.ny * stageRef.current.h);
      (isUser ? setUserSortY : setCompSortY)(point.ny);
    };
    const pose = (point: RoomPoint, destination: SeatKind, done: () => void) => {
      stopWalkCycle(walkTimerRef);
      play(Animated.timing(fade, { toValue: 0, duration: 100, useNativeDriver: true }), () => {
        place(point);
        seatRef.current = destination;
        setAction(actionForSeat(destination));
        setFacing(destination === "sofa" && isUser);
        // The sleeping sprite and foreground mask are committed together while hidden.
        requestAnimationFrame(() => {
          if (current()) play(Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true }), done);
        });
      });
    };
    const finalPoint = path.at(-1) ?? end;
    if (feedback === "ripple") triggerRipple(finalPoint.nx * stage.w, finalPoint.ny * stage.h);
    const finish = () => onArrival?.();

    if (sameSeat) {
      pose(target, seat, finish);
      return;
    }

    let walking = false;
    const walk = (index: number) => {
      const next = path[index];
      if (!next) {
        stopWalkCycle(walkTimerRef);
        if (seat === "none") {
          setAction("idle");
          finish();
        } else {
          setAction("idle");
          pose(target, seat, finish);
        }
        return;
      }
      const { w, h } = stageRef.current;
      const dx = (next.nx - normRef.current.nx) * w;
      const dy = (next.ny - normRef.current.ny) * h;
      const distance = Math.hypot(dx, dy);
      if (distance < 1) {
        walk(index + 1);
        return;
      }
      if (Math.abs(dx) > 1) setFacing(dx < 0);
      if (!walking) {
        walking = true;
        startWalkCycle(walkTimerRef, setAction);
      }
      const duration = Math.max(85, Math.round(distance * 5.6));
      play(Animated.parallel([
        Animated.timing(x, { toValue: next.nx * w, duration, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(y, { toValue: next.ny * h, duration, easing: Easing.linear, useNativeDriver: true }),
      ]), () => {
        place(next);
        walk(index + 1);
      });
    };
    if (currentSeat === "none") walk(0);
    else pose(start, "none", () => walk(0));
  }

  function handleFloorPress(e: GestureResponderEvent) {
    // A floor tap never gives the Companion a new destination.
    if (duoActive.current) stopRoomMotion();
    setCompanionMenuOpen(false);
    const target = {
      nx: e.nativeEvent.locationX / Math.max(1, stage.w),
      ny: e.nativeEvent.locationY / Math.max(1, stage.h),
    };
    const plan = planMove("user", target, "none");
    if (!plan) return;
    clearTimeout(waveTimer.current);
    moveCharacterAlong("user", target, "none", "ripple", plan);
  }

  function toggleCompanionMenu() {
    if (isActive && appActive && !isCompanionView && !someoneSleeping && !duoActive.current) {
      setCompanionMenuOpen(open => !open);
    }
  }

  function reactInPlace() {
    companionReact.stopAnimation();
    companionReact.setValue(0);
    Animated.sequence([
      Animated.timing(companionReact, { toValue: 1, duration: 110, useNativeDriver: true }),
      Animated.timing(companionReact, { toValue: 0, duration: 190, useNativeDriver: true }),
    ]).start();
  }

  function moveTogether(companion: RoomPoint, user: RoomPoint, seat: SeatKind) {
    stopRoomMotion();
    const companionPlan = planMove("companion", companion, seat);
    const userPlan = planMove("user", user, seat);
    if (!companionPlan || !userPlan) return;
    moveCharacterAlong("companion", companion, seat, undefined, companionPlan);
    moveCharacterAlong("user", user, seat, undefined, userPlan);
  }

  function handleSitTogether() {
    moveTogether({ nx: 0.525, ny: 0.678 }, { nx: 0.625, ny: 0.678 }, "sofa");
  }

  function playSocialAction(action: CompanionAction) {
    if (!isActive || !appActive || isCompanionView) return;
    stopRoomMotion();
    if (action === "WAVE") {
      if (userSeatRef.current === "none") {
        setUserAction("wave");
        waveTimer.current = setTimeout(() => setUserAction(actionForSeat(userSeatRef.current)), 850);
      }
      reactInPlace();
      onAction?.(action);
      return;
    }

    const companion = { nx: 0.48, ny: DUO_BASELINE };
    const user = { nx: 0.57, ny: DUO_BASELINE };
    const companionPlan = planMove("companion", companion, "none", true);
    const userPlan = planMove("user", user, "none", true);
    if (!companionPlan || !userPlan) return;

    const epoch = duoEpoch.current;
    duoActive.current = true;
    let arrivals = 0;
    const arrived = () => {
      if (epoch !== duoEpoch.current || ++arrivals !== 2) return;
      setDuo({ action, frame: 0 });
      spawnHeart(DUO_CENTER * stage.w, DUO_BASELINE * stage.h - charH);
      let frame = 0;
      duoTimer.current = setInterval(() => {
        if (++frame === 6) {
          clearInterval(duoTimer.current);
          duoActive.current = false;
          setDuo(undefined);
        } else {
          setDuo({ action, frame: frame % 2 });
        }
      }, 280);
    };
    moveCharacterAlong("companion", companion, "none", undefined, companionPlan, arrived);
    moveCharacterAlong("user", user, "none", undefined, userPlan, arrived);
    onAction?.(action);
  }

  function handleRestTogether() {
    moveTogether({ nx: 0.125, ny: 0.432 }, { nx: 0.222, ny: 0.432 }, "bed");
  }

  function handleWakeUp() {
    stopRoomMotion();
    if (userSeatRef.current === "bed") moveCharacterAlong("user", { nx: 0.56, ny: 0.46 });
    if (compSeatRef.current === "bed") moveCharacterAlong("companion", { nx: 0.45, ny: 0.46 });
  }

  function handleSlotPress(interactive: "diary" | "pet") {
    if (interactive === "pet") {
      bounceAnim(petBounce);
      spawnHeart(stage.w * 0.57, stage.h * 0.24);
    } else {
      bounceAnim(diaryBounce);
      onOpenDiary?.();
    }
  }

  function toggleNightMode() {
    modeSpin.setValue(0);
    Animated.spring(modeSpin, {
      toValue: 1,
      speed: 16,
      bounciness: 10,
      useNativeDriver: true,
    }).start();
    setNightMode((v) => !v);
  }

  const charH = Math.round(stage.h * 0.175);
  const charW = Math.round(charH * 0.8);
  const duoWidth = charH * 280 / 230;
  const compSprites = isCompanionView ? GIRL_SPRITES : BOY_SPRITES;
  const userSprites = isCompanionView ? BOY_SPRITES : GIRL_SPRITES;

  const zFromY = (yFrac: number) => Math.round(yFrac * 100);
  const revealScale = roomReveal.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] });
  const modeRotate = modeSpin.interpolate({ inputRange: [0, 1], outputRange: ["-24deg", "0deg"] });

  return (
    <View style={styles.frame} onLayout={onLayout}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: roomReveal, transform: [{ scale: revealScale }] },
        ]}
      >
        {/* Base empty 4:5 room */}
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="点击小家木地板走动"
          onPress={handleFloorPress}
        >
          <Image
            source={ROOM_BASE_IMAGE}
            style={styles.roomImg}
            resizeMode="cover"
            fadeDuration={0}
            onLoad={() => markAssetLoaded("base")}
          />
        </Pressable>

        {/* 10 Swappable Furniture & Wall Slots */}
        {ROOM_SLOTS.map((slot) => {
          const zIndex =
            slot.layer === "floor_base" ? 2 :
            slot.layer === "wall_back" ? 6 :
            zFromY(slot.sortY);

          const boxStyle = {
            position: "absolute" as const,
            left: stage.w * slot.left,
            top: stage.h * slot.top,
            width: stage.w * slot.width,
            height: stage.h * slot.height,
            zIndex,
          };

          if (slot.id === "slot_sofa") {
            const w = boxStyle.width;
            const h = boxStyle.height;
            const strips = [
              { x: 0, y: 0, width: 1, height: 0.24, foreground: false },
              { x: 0.13, y: 0.24, width: 0.74, height: 0.66, foreground: false },
              { x: 0, y: 0.24, width: 0.13, height: 0.66, foreground: true },
              { x: 0.87, y: 0.24, width: 0.13, height: 0.66, foreground: true },
              { x: 0, y: 0.90, width: 1, height: 0.10, foreground: true },
            ];
            return [
              <Pressable
                key={slot.id}
                style={[boxStyle, { zIndex: 65 }]}
                onPress={handleSitTogether}
                accessibilityRole="button"
                accessibilityLabel="在沙发一起坐"
              />,
              ...strips.map((strip, index) => (
                <View key={`sofa-${index}`} pointerEvents="none" style={{
                  position: "absolute",
                  overflow: "hidden",
                  left: boxStyle.left + w * strip.x,
                  top: boxStyle.top + h * strip.y,
                  width: w * strip.width,
                  height: h * strip.height,
                  zIndex: strip.foreground ? zFromY(slot.top + slot.height) : zIndex,
                }}>
                  <Image
                    source={slot.source}
                    style={{ position: "absolute", left: -w * strip.x, top: -h * strip.y, width: w, height: h }}
                    resizeMode="contain"
                    fadeDuration={0}
                    onLoad={index === 0 ? () => markAssetLoaded(slot.id) : undefined}
                  />
                </View>
              )),
            ];
          }

          if (slot.id === "slot_bed") {
            return (
              <Pressable
                key={slot.id}
                style={boxStyle}
                onPress={someoneSleeping ? handleWakeUp : handleRestTogether}
                accessibilityRole="button"
                accessibilityLabel={someoneSleeping ? "从床上起身" : "在床上休息"}
              >
                <Image source={slot.source} style={styles.fillImg} resizeMode="contain" fadeDuration={0}
                  onLoad={() => markAssetLoaded(slot.id)} />
              </Pressable>
            );
          }

          if (slot.interactive) {
            const interactive = slot.interactive;
            const scaleAnim = interactive === "pet" ? petBounce : diaryBounce;

            return (
              <Pressable
                key={slot.id}
                style={boxStyle}
                onPress={() => handleSlotPress(interactive)}
                accessibilityRole="button"
                accessibilityLabel={slot.name}
              >
                <Animated.View style={[styles.fillImg, { transform: [{ scale: scaleAnim }] }]}>
                  <Image
                    source={slot.source}
                    style={styles.fillImg}
                    resizeMode="contain"
                    fadeDuration={0}
                    onLoad={() => markAssetLoaded(slot.id)}
                  />
                </Animated.View>
              </Pressable>
            );
          }
          return (
            <View key={slot.id} pointerEvents="none" style={boxStyle}>
              <Image
                source={slot.source}
                style={styles.fillImg}
                resizeMode="contain"
                fadeDuration={0}
                onLoad={() => markAssetLoaded(slot.id)}
              />
            </View>
          );
        })}

        {/* Double concentric pearl ripple on floor tap */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.rippleOuter,
            {
              left: ripplePos.x - 16,
              top: ripplePos.y - 9,
              opacity: rippleOuterOpacity,
              transform: [{ scale: rippleOuterScale }],
            },
          ]}
        />
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

        <View pointerEvents="none" style={{
          position: "absolute",
          width: duoWidth,
          height: charH,
          left: stage.w * DUO_CENTER - duoWidth / 2,
          top: stage.h * DUO_BASELINE - charH,
          zIndex: zFromY(DUO_BASELINE) + 3,
        }}>
          {DUO_ACTIONS.flatMap(action => DUO_SPRITES[action].map((source, frame) => (
            <Image
              key={`${action}:${frame}`}
              source={source}
              style={[StyleSheet.absoluteFill, styles.fillImg, { opacity: duo?.action === action && duo.frame === frame ? 1 : 0 }]}
              resizeMode="contain"
              fadeDuration={0}
            />
          )))}
        </View>

        {/* Companion Pixel Character */}
        <Animated.View
          style={[
            styles.spriteWrap,
            {
              width: charW,
              height: charH,
              opacity: duo ? 0 : compFade,
              zIndex: compAction === "sleep" ? 54 : compAction === "sit" ? 66 : zFromY(compSortY) + 1,
              transform: [
                { translateX: Animated.subtract(compX, charW / 2) },
                { translateY: Animated.subtract(compY, charH) },
                { translateY: idleFloatB },
                { scaleY: companionReact.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) },
              ],
            },
          ]}
        >
          <Pressable
            disabled={isCompanionView || someoneSleeping || !!duo}
            onPress={toggleCompanionMenu}
            accessibilityState={{ expanded: companionMenuOpen }}
            style={styles.charHit}
            accessibilityRole="button"
            accessibilityLabel={`与 ${companionName} 互动`}
          >
            {compAction !== "sit" && compAction !== "sleep" && <View style={[styles.spriteShadow, { width: charW * 0.56 }]} />}
            <Image
              source={compSprites[compAction]}
              style={[styles.fillImg, compFacingLeft && { transform: [{ scaleX: -1 }] }]}
              resizeMode="contain"
              fadeDuration={0}
              onLoad={compAction === "idle" ? () => markAssetLoaded("comp_idle") : undefined}
            />
          </Pressable>
        </Animated.View>

        {/* Walkable User Pixel Character */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.spriteWrap,
            {
              width: charW,
              height: charH,
              opacity: duo ? 0 : userFade,
              zIndex: userAction === "sleep" ? 55 : userAction === "sit" ? 67 : zFromY(userSortY) + 2,
              transform: [
                { translateX: Animated.subtract(userX, charW / 2) },
                { translateY: Animated.subtract(userY, charH) },
                { translateY: idleFloatA },
              ],
            },
          ]}
        >
          {userAction !== "sit" && userAction !== "sleep" && <View style={[styles.spriteShadow, { width: charW * 0.56 }]} />}
          <Image
            source={userSprites[userAction]}
            style={[styles.fillImg, userFacingLeft && { transform: [{ scaleX: -1 }] }]}
            resizeMode="contain"
            fadeDuration={0}
            onLoad={userAction === "idle" ? () => markAssetLoaded("user_idle") : undefined}
          />
        </Animated.View>

        {/* Bed Quilt Foreground Overlay (tucks sleeping characters cleanly under the blanket) */}
        {someoneSleeping && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: stage.w * 0.025,
              top: stage.h * 0.23,
              width: stage.w * 0.42,
              height: stage.h * 0.31,
              zIndex: 56,
            }}
          >
            <Image source={BED_QUILT_OVERLAY} style={styles.fillImg} resizeMode="contain" fadeDuration={0} />
          </View>
        )}

        {/* Gentle Floating Zzz when resting in bed */}
        {someoneSleeping && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: stage.w * 0.25,
              top: stage.h * 0.23,
              zIndex: 122,
              opacity: zzzAnim.interpolate({ inputRange: [0, 0.2, 0.8, 1], outputRange: [0, 0.9, 0.7, 0] }),
              transform: [
                { translateY: zzzAnim.interpolate({ inputRange: [0, 1], outputRange: [6, -22] }) },
                { translateX: zzzAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 8] }) },
              ],
            }}
          >
            <Text style={styles.zzzText}>Zzz</Text>
          </Animated.View>
        )}

        {/* Night Ambient Veil */}
        {nightMode && (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 110 }]}>
            <View style={styles.nightVeil} />
          </View>
        )}

        {/* Floating Hearts */}
        {hearts.map((h) => (
          <Animated.View
            key={h.id}
            pointerEvents="none"
            style={[
              styles.heartWrap,
              {
                left: h.x - 8,
                top: h.y,
                opacity: h.anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
                transform: [
                  { translateY: h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -34] }) },
                  { scale: h.anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 1.18, 0.9] }) },
                ],
              },
            ]}
          >
            <Ionicons name="heart" size={14} color="#C87D87" />
          </Animated.View>
        ))}

        {/* Top-right Day/Night ambient toggle */}
        <Pressable
          onPress={toggleNightMode}
          accessibilityRole="button"
          accessibilityLabel="切换昼夜光线"
          style={({ pressed }) => [styles.topRightOverlay, pressed && { transform: [{ scale: 0.88 }] }]}
        >
          <Animated.View
            style={[
              styles.modeBtn,
              nightMode ? styles.modeBtnDark : styles.modeBtnLight,
              { transform: [{ rotate: modeRotate }] },
            ]}
          >
            <Ionicons
              name={nightMode ? "moon" : "sunny-outline"}
              size={15}
              color={nightMode ? "#FDE68A" : PEARL_UI.accentInk}
            />
          </Animated.View>
        </Pressable>

        {(someoneSleeping || !isCompanionView) && (
          <View style={styles.actionBarWrap}>
            <LiquidGlassSurface glass tint={nightMode ? "dark" : "light"} borderRadius={RADIUS.pill}>
              <View style={styles.actionBar}>
                {companionMenuOpen && !someoneSleeping && COMPANION_MENU.map(([action, label]) => (
                  <Pressable
                    key={action}
                    accessibilityRole="button"
                    onPress={() => playSocialAction(action)}
                    style={styles.actionItem}
                  >
                    <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>{label}</Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={someoneSleeping ? "起身" : "互动"}
                  accessibilityState={someoneSleeping ? undefined : { expanded: companionMenuOpen }}
                  onPress={someoneSleeping ? handleWakeUp : toggleCompanionMenu}
                  style={[styles.actionItem, styles.actionToggle]}
                >
                  <Ionicons
                    name={someoneSleeping ? "sunny-outline" : "heart-outline"}
                    size={14}
                    color={nightMode ? "#F8FAFC" : PEARL_UI.ink}
                  />
                  <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>
                    {someoneSleeping ? "起身" : "互动"}
                  </Text>
                </Pressable>
              </View>
            </LiquidGlassSurface>
          </View>
        )}
      </Animated.View>

      {/* Silky Liquid Pearl Loader until base room + slots + idle sprites are all loaded */}
      <PearlTransitionLoader visible={!roomReady} borderRadius={28} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    aspectRatio: 0.8,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: PEARL_UI.highlight,
    backgroundColor: "#EFEAE7",
    overflow: "hidden",
    shadowColor: "#6B5E54",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 4,
  },
  roomImg: { width: "100%", height: "100%" },
  fillImg: { width: "100%", height: "100%" },
  nightVeil: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(26, 34, 58, 0.22)",
  },
  rippleOuter: {
    position: "absolute",
    width: 32,
    height: 18,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(180, 192, 212, 0.72)",
    zIndex: 7,
  },
  ripple: {
    position: "absolute",
    width: 28,
    height: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.92)",
    backgroundColor: "rgba(255, 255, 255, 0.24)",
    zIndex: 8,
  },
  spriteWrap: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  charHit: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  spriteShadow: {
    position: "absolute",
    bottom: 2,
    height: 8,
    borderRadius: 5,
    backgroundColor: "rgba(56, 44, 38, 0.16)",
  },
  heartWrap: { position: "absolute", zIndex: 130 },
  topRightOverlay: { position: "absolute", top: 12, right: 12, zIndex: 125 },
  modeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    shadowColor: "#6F685E",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  modeBtnLight: {
    backgroundColor: "rgba(255, 255, 255, 0.72)",
    borderColor: "rgba(255, 255, 255, 0.92)",
  },
  modeBtnDark: {
    backgroundColor: "rgba(30, 38, 56, 0.72)",
    borderColor: "rgba(255, 255, 255, 0.28)",
  },
  actionBarWrap: { position: "absolute", bottom: 12, right: 12, zIndex: 125 },
  actionBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  actionItem: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  actionToggle: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { fontSize: 11.5, fontWeight: "600", color: PEARL_UI.ink },
  actionTextDark: { color: "#F8FAFC" },
  zzzText: {
    fontSize: 13,
    fontWeight: "700",
    color: PEARL_UI.accent,
    letterSpacing: 1,
    textShadowColor: "rgba(255,255,255,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
