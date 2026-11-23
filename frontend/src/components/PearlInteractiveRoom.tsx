import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
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
  GIRL_SPRITES,
  ROOM_BASE_IMAGE,
  ROOM_SLOTS,
  type CharacterAction,
} from "../room/roomSlots";

const COMPANION_WHISPERS = [
  "今晚风大，回来喝杯热的。",
  "靠枕换软了，过来坐会儿。",
  "贴贴～今天辛苦啦。",
  "黑胶机刚放了你喜欢的歌。",
  "窗台的小猫刚睡着呢。",
];

interface FloatingHeart {
  id: number;
  x: number;
  y: number;
  anim: Animated.Value;
}

interface ObstacleBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type SeatKind = "none" | "sofa" | "bed";

// Normalized furniture foot-collision boxes (0..1)
const ROOM_OBSTACLES: ObstacleBox[] = [
  { x1: 0.02, y1: 0.22, x2: 0.35, y2: 0.56 }, // Double bed
  { x1: 0.33, y1: 0.28, x2: 0.45, y2: 0.43 }, // Nightstand
  { x1: 0.65, y1: 0.22, x2: 0.98, y2: 0.43 }, // USM vinyl cabinet + floor lamp
  { x1: 0.82, y1: 0.37, x2: 0.99, y2: 0.68 }, // Wavy mirror
  { x1: 0.40, y1: 0.50, x2: 0.75, y2: 0.68 }, // Double sofa
  { x1: 0.42, y1: 0.65, x2: 0.73, y2: 0.79 }, // Cloud coffee table
  { x1: 0.03, y1: 0.56, x2: 0.23, y2: 0.83 }, // Olive plant
];

const GRID_COLS = 24;
const GRID_ROWS = 30;
const WALK_MIN_X = 0.14;
const WALK_MAX_X = 0.81;
const WALK_MIN_Y = 0.42;
const WALK_MAX_Y = 0.87;

const WALK_FRAMES: CharacterAction[] = ["walk_1", "walk_2", "walk_3", "walk_4"];
// Base room + all slots + both characters' idle sprites
const TOTAL_ROOM_ASSETS = 1 + ROOM_SLOTS.length + 2;

function isPointBlocked(nx: number, ny: number): boolean {
  if (nx < WALK_MIN_X || nx > WALK_MAX_X || ny < WALK_MIN_Y || ny > WALK_MAX_Y) return true;
  for (const b of ROOM_OBSTACLES) {
    if (nx >= b.x1 && nx <= b.x2 && ny >= b.y1 && ny <= b.y2) return true;
  }
  return false;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, b: ObstacleBox, pad = 0.012): boolean {
  const x1 = b.x1 - pad;
  const y1 = b.y1 - pad;
  const x2 = b.x2 + pad;
  const y2 = b.y2 + pad;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, ax - x1],
    [dx, x2 - ax],
    [-dy, ay - y1],
    [dy, y2 - ay],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-8) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

function isSegmentClear(ax: number, ay: number, bx: number, by: number): boolean {
  if (
    ax < WALK_MIN_X || ax > WALK_MAX_X || ay < WALK_MIN_Y || ay > WALK_MAX_Y ||
    bx < WALK_MIN_X || bx > WALK_MAX_X || by < WALK_MIN_Y || by > WALK_MAX_Y
  ) {
    return false;
  }
  for (const b of ROOM_OBSTACLES) {
    if (segmentIntersectsBox(ax, ay, bx, by, b, 0.012)) return false;
  }
  return true;
}

function nearestWalkableCell(nx: number, ny: number): [number, number] {
  const targetC = Math.max(0, Math.min(GRID_COLS - 1, Math.round(nx * (GRID_COLS - 1))));
  const targetR = Math.max(0, Math.min(GRID_ROWS - 1, Math.round(ny * (GRID_ROWS - 1))));
  let bestC = targetC;
  let bestR = targetR;
  let bestDist = Infinity;
  for (let r = 0; r < GRID_ROWS; r++) {
    const gy = r / (GRID_ROWS - 1);
    for (let c = 0; c < GRID_COLS; c++) {
      const gx = c / (GRID_COLS - 1);
      if (isPointBlocked(gx, gy)) continue;
      const d = (c - targetC) * (c - targetC) + (r - targetR) * (r - targetR);
      if (d < bestDist) {
        bestDist = d;
        bestC = c;
        bestR = r;
      }
    }
  }
  return [bestC, bestR];
}

/**
 * 8-directional BFS + line-of-sight smoothing on normalized room grid.
 * Guarantees ZERO clipping through sofa, coffee table, bed, plant, or mirror.
 */
function findSafePath(
  startNx: number,
  startNy: number,
  goalNx: number,
  goalNy: number,
): Array<{ nx: number; ny: number }> {
  const [sc, sr] = nearestWalkableCell(startNx, startNy);
  const [gc, gr] = nearestWalkableCell(goalNx, goalNy);
  const goalPt = { nx: gc / (GRID_COLS - 1), ny: gr / (GRID_ROWS - 1) };

  if (sc === gc && sr === gr) return [goalPt];
  if (isSegmentClear(startNx, startNy, goalPt.nx, goalPt.ny)) return [goalPt];

  const total = GRID_COLS * GRID_ROWS;
  const visited = new Uint8Array(total);
  const parent = new Int32Array(total).fill(-1);
  const queue: number[] = [];
  const startIdx = sr * GRID_COLS + sc;
  const goalIdx = gr * GRID_COLS + gc;

  visited[startIdx] = 1;
  queue.push(startIdx);

  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let found = false;
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    if (curr === goalIdx) {
      found = true;
      break;
    }
    const cc = curr % GRID_COLS;
    const cr = Math.floor(curr / GRID_COLS);
    for (const [dc, dr] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const nIdx = nr * GRID_COLS + nc;
      if (visited[nIdx]) continue;
      const gx = nc / (GRID_COLS - 1);
      const gy = nr / (GRID_ROWS - 1);
      if (isPointBlocked(gx, gy)) continue;
      // Prevent corner cutting on diagonals
      if (dc !== 0 && dr !== 0) {
        if (
          isPointBlocked((cc + dc) / (GRID_COLS - 1), cr / (GRID_ROWS - 1)) ||
          isPointBlocked(cc / (GRID_COLS - 1), (cr + dr) / (GRID_ROWS - 1))
        ) {
          continue;
        }
      }
      visited[nIdx] = 1;
      parent[nIdx] = curr;
      queue.push(nIdx);
    }
  }

  if (!found) return [goalPt];

  const raw: Array<{ nx: number; ny: number }> = [];
  let cur = goalIdx;
  while (cur !== -1 && cur !== startIdx) {
    const c = cur % GRID_COLS;
    const r = Math.floor(cur / GRID_COLS);
    raw.push({ nx: c / (GRID_COLS - 1), ny: r / (GRID_ROWS - 1) });
    cur = parent[cur];
  }
  raw.reverse();

  // Line-of-sight smoothing to produce clean, natural turns
  const smoothed: Array<{ nx: number; ny: number }> = [];
  let anchor = { nx: startNx, ny: startNy };
  let i = 0;
  while (i < raw.length) {
    let farthest = i;
    for (let j = raw.length - 1; j > i; j--) {
      if (isSegmentClear(anchor.nx, anchor.ny, raw[j].nx, raw[j].ny)) {
        farthest = j;
        break;
      }
    }
    smoothed.push(raw[farthest]);
    anchor = raw[farthest];
    i = farthest + 1;
  }
  return smoothed;
}

export function PearlInteractiveRoom({
  userName,
  companionName,
  isCompanionView,
  isActive = true,
  onActionTriggered,
}: {
  userName: string;
  companionName: string;
  isCompanionView: boolean;
  isActive?: boolean;
  onActionTriggered?: (action: "wave" | "sit" | "snuggle" | "diary") => void;
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
  const [whisperIndex, setWhisperIndex] = useState(0);
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);
  const [bedMenuOpen, setBedMenuOpen] = useState(false);
  const zzzAnim = useRef(new Animated.Value(0)).current;

  // Unified non-overlapping speech bubble state
  const [roomSpeech, setRoomSpeech] = useState<{
    text: string;
    sender: "user" | "companion";
    nx: number;
    ny: number;
  } | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [appActive, setAppActive] = useState(true);
  const mountedAtRef = useRef(Date.now());
  const heartIdRef = useRef(0);
  const userTokenRef = useRef(0);
  const compTokenRef = useRef(0);
  const userAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const compAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const userWalkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compWalkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const actionResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setTimeout(() => setRoomReady(true), wait);
    }
  }

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const fallback = setTimeout(() => setRoomReady(true), 760);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (!roomReady) return;
    Animated.timing(roomReveal, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
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

  // Pause idle loops, walks, and timers when off-screen or backgrounded
  useEffect(() => {
    if (!isActive || !appActive) {
      userAnimRef.current?.stop();
      compAnimRef.current?.stop();
      stopWalkCycle(userWalkTimerRef);
      stopWalkCycle(compWalkTimerRef);
      if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
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
  }, [isActive, appActive, idleFloatA, idleFloatB]);

  useEffect(() => {
    return () => {
      userAnimRef.current?.stop();
      compAnimRef.current?.stop();
      if (userWalkTimerRef.current) clearInterval(userWalkTimerRef.current);
      if (compWalkTimerRef.current) clearInterval(compWalkTimerRef.current);
      if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
      if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    };
  }, []);

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    stageRef.current = { w: width, h: height };
    setStage({ w: width, h: height });
    // Restore preserved normalized coordinates instead of resetting positions!
    compX.setValue(compNormRef.current.nx * width);
    compY.setValue(compNormRef.current.ny * height);
    userX.setValue(userNormRef.current.nx * width);
    userY.setValue(userNormRef.current.ny * height);
  }

  function showSpeech(text: string, sender: "user" | "companion", nx: number, ny: number, ms = 2600) {
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    setRoomSpeech({ text, sender, nx, ny });
    speechTimerRef.current = setTimeout(() => setRoomSpeech(null), ms);
  }

  function spawnHeart(x: number, y: number) {
    const id = ++heartIdRef.current;
    const anim = new Animated.Value(0);
    setHearts((prev) => [...prev.slice(-5), { id, x, y, anim }]);
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

  function popCompanionWhisper() {
    const next = (whisperIndex + 1) % COMPANION_WHISPERS.length;
    setWhisperIndex(next);
    showSpeech(COMPANION_WHISPERS[next], "companion", compNormRef.current.nx, compNormRef.current.ny);
    spawnHeart(compNormRef.current.nx * stage.w, compNormRef.current.ny * stage.h - stage.h * 0.14);
  }

  /**
   * Shared path-following engine for BOTH user and companion:
   * - Exits current seat cleanly before walking
   * - Uses obstacle-free BFS path on walkable grid
   * - Updates facing per segment & loops all 4 walk frames
   */
  function moveCharacterAlong(
    who: "user" | "companion",
    targetNx: number,
    targetNy: number,
    opts?: {
      finalAction?: CharacterAction;
      finalFacingLeft?: boolean;
      seat?: SeatKind;
      approachPoint?: { nx: number; ny: number };
      showRipple?: boolean;
      onArrive?: () => void;
    },
  ) {
    const isUser = who === "user";
    const tokenRef = isUser ? userTokenRef : compTokenRef;
    const myToken = ++tokenRef.current;
    const animRef = isUser ? userAnimRef : compAnimRef;
    const walkTimerRef = isUser ? userWalkTimerRef : compWalkTimerRef;
    const normRef = isUser ? userNormRef : compNormRef;
    const seatRef = isUser ? userSeatRef : compSeatRef;
    const animX = isUser ? userX : compX;
    const animY = isUser ? userY : compY;
    const setAction = isUser ? setUserAction : setCompAction;
    const setFacingLeft = isUser ? setUserFacingLeft : setCompFacingLeft;

    animRef.current?.stop();
    stopWalkCycle(walkTimerRef);

    const w = stageRef.current.w;
    const h = stageRef.current.h;
    const curSeat = seatRef.current;
    const nextSeat: SeatKind = opts?.seat ?? "none";

    // Build obstacle-free waypoint chain
    const chain: Array<{ nx: number; ny: number }> = [];
    let startNx = normRef.current.nx;
    let startNy = normRef.current.ny;

    // 1) If currently seated on sofa/bed and moving elsewhere, step cleanly to exit point first
    if (curSeat === "sofa" && nextSeat !== "sofa") {
      const exitPt = { nx: startNx < 0.58 ? 0.38 : 0.77, ny: 0.56 };
      chain.push(exitPt);
      startNx = exitPt.nx;
      startNy = exitPt.ny;
    } else if (curSeat === "bed" && nextSeat !== "bed") {
      const exitPt = { nx: 0.39, ny: 0.49 };
      chain.push(exitPt);
      startNx = exitPt.nx;
      startNy = exitPt.ny;
    }

    // 2) Route across walkable grid
    if (nextSeat !== "none" && opts?.approachPoint) {
      if (!(curSeat === nextSeat)) {
        const approachPath = findSafePath(startNx, startNy, opts.approachPoint.nx, opts.approachPoint.ny);
        chain.push(...approachPath);
      }
      chain.push({ nx: targetNx, ny: targetNy });
    } else if (nextSeat === "none") {
      const floorPath = findSafePath(startNx, startNy, targetNx, targetNy);
      chain.push(...floorPath);
    } else {
      chain.push({ nx: targetNx, ny: targetNy });
    }

    const finalPt = chain[chain.length - 1] ?? { nx: targetNx, ny: targetNy };
    if (opts?.showRipple) {
      triggerRipple(finalPt.nx * w, finalPt.ny * h);
    }

    seatRef.current = curSeat === nextSeat ? nextSeat : "none";

    let walkStarted = false;
    const runStep = (idx: number) => {
      if (tokenRef.current !== myToken) return;
      if (idx >= chain.length) {
        stopWalkCycle(walkTimerRef);
        seatRef.current = nextSeat;
        setAction(opts?.finalAction ?? "idle");
        if (typeof opts?.finalFacingLeft === "boolean") {
          setFacingLeft(opts.finalFacingLeft);
        }
        opts?.onArrive?.();
        return;
      }

      const pt = chain[idx];
      const px = pt.nx * w;
      const py = pt.ny * h;
      const cx = normRef.current.nx * w;
      const cy = normRef.current.ny * h;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy);

      if (dist < 2) {
        runStep(idx + 1);
        return;
      }

      if (Math.abs(dx) > 2) setFacingLeft(dx < 0);
      if (!walkStarted && dist > 6) { walkStarted = true; startWalkCycle(walkTimerRef, setAction); }

      const dur = Math.max(180, Math.min(1150, Math.round(dist * 5.6)));
      animRef.current = Animated.parallel([
        Animated.timing(animX, {
          toValue: px,
          duration: dur,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(animY, {
          toValue: py,
          duration: dur,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]);
      animRef.current.start(({ finished }) => {
        if (!finished || tokenRef.current !== myToken) return;
        runStep(idx + 1);
      });
    };

    runStep(0);
  }

  function handleFloorPress(e: GestureResponderEvent) {
    if (bedMenuOpen) setBedMenuOpen(false);
    const nx = e.nativeEvent.locationX / Math.max(1, stage.w);
    const ny = e.nativeEvent.locationY / Math.max(1, stage.h);
    moveCharacterAlong("user", nx, ny, {
      finalAction: "idle",
      seat: "none",
      showRipple: true,
      onArrive: () => {
        const dist = Math.hypot(
          (userNormRef.current.nx - compNormRef.current.nx) * stage.w,
          (userNormRef.current.ny - compNormRef.current.ny) * stage.h,
        );
        if (dist < 64) popCompanionWhisper();
      },
    });
  }

  function handleWave() {
    if (bedMenuOpen) setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
    const needFloor = userSeatRef.current !== "none" || compSeatRef.current !== "none";

    if (needFloor) {
      moveCharacterAlong("companion", 0.46, 0.46, {
        finalAction: "wave",
        finalFacingLeft: false,
        seat: "none",
      });
      moveCharacterAlong("user", 0.59, 0.46, {
        finalAction: "wave",
        finalFacingLeft: true,
        seat: "none",
        onArrive: () => {
          showSpeech("嗨～回来啦", "companion", 0.52, 0.46);
          spawnHeart(stage.w * 0.525, stage.h * 0.31);
          actionResetTimerRef.current = setTimeout(() => {
            setUserAction("idle");
            setCompAction("idle");
          }, 1800);
        },
      });
    } else {
      setUserAction("wave");
      setCompAction("wave");
      setCompFacingLeft(false);
      setUserFacingLeft(true);
      showSpeech("嗨～回来啦", "companion", compNormRef.current.nx, compNormRef.current.ny);
      spawnHeart(compNormRef.current.nx * stage.w, compNormRef.current.ny * stage.h - stage.h * 0.14);
      actionResetTimerRef.current = setTimeout(() => {
        setUserAction("idle");
        setCompAction("idle");
      }, 1800);
    }
    onActionTriggered?.("wave");
  }

  function handleSitTogether() {
    if (bedMenuOpen) setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
    // Grounded cleanly on sofa cushions (10% apart: zero head overlap, zero floating)
    moveCharacterAlong("companion", 0.525, 0.678, {
      finalAction: "sit",
      finalFacingLeft: false,
      seat: "sofa",
      approachPoint: { nx: 0.38, ny: 0.56 },
    });
    moveCharacterAlong("user", 0.625, 0.678, {
      finalAction: "sit",
      finalFacingLeft: true,
      seat: "sofa",
      approachPoint: { nx: 0.77, ny: 0.56 },
      onArrive: () => {
        showSpeech("靠枕换软了，过来坐会儿。", "companion", 0.575, 0.65);
        spawnHeart(stage.w * 0.575, stage.h * 0.52);
      },
    });
    onActionTriggered?.("sit");
  }

  function handleSnuggle() {
    if (bedMenuOpen) setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);

    if (userSeatRef.current === "sofa" && compSeatRef.current === "sofa") {
      // Scoot gently closer on the sofa (7.6% apart — shoulders close, faces clear)
      moveCharacterAlong("companion", 0.538, 0.678, {
        finalAction: "sit",
        finalFacingLeft: false,
        seat: "sofa",
      });
      moveCharacterAlong("user", 0.614, 0.678, {
        finalAction: "sit",
        finalFacingLeft: true,
        seat: "sofa",
        onArrive: () => {
          showSpeech("贴贴～今天辛苦啦。", "companion", 0.576, 0.65);
          spawnHeart(stage.w * 0.568, stage.h * 0.52);
          setTimeout(() => spawnHeart(stage.w * 0.588, stage.h * 0.54), 220);
        },
      });
    } else {
      // Snuggle on the open wooden floor area (works cleanly even if previously sitting on bed!)
      moveCharacterAlong("companion", 0.475, 0.46, {
        finalAction: "wave",
        finalFacingLeft: false,
        seat: "none",
      });
      moveCharacterAlong("user", 0.575, 0.46, {
        finalAction: "wave",
        finalFacingLeft: true,
        seat: "none",
        onArrive: () => {
          setCompAction("wave");
          setCompFacingLeft(false);
          showSpeech("贴贴～今天辛苦啦。", "companion", 0.525, 0.46);
          spawnHeart(stage.w * 0.515, stage.h * 0.30);
          setTimeout(() => spawnHeart(stage.w * 0.538, stage.h * 0.32), 220);
          actionResetTimerRef.current = setTimeout(() => {
            setUserAction("idle");
            setCompAction("idle");
          }, 1600);
        },
      });
    }
    onActionTriggered?.("snuggle");
  }

  function handleRestSolo() {
    setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
    // Walk to bedside, change into pajamas, tuck under quilt on right pillow
    moveCharacterAlong("user", 0.222, 0.432, {
      finalAction: "sleep",
      finalFacingLeft: false,
      seat: "bed",
      approachPoint: { nx: 0.40, ny: 0.48 },
    });
  }

  function handleRestTogether() {
    setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
    moveCharacterAlong("companion", 0.125, 0.432, {
      finalAction: "sleep",
      finalFacingLeft: false,
      seat: "bed",
      approachPoint: { nx: 0.39, ny: 0.47 },
    });
    moveCharacterAlong("user", 0.222, 0.432, {
      finalAction: "sleep",
      finalFacingLeft: false,
      seat: "bed",
      approachPoint: { nx: 0.42, ny: 0.49 },
    });
  }

  function handleWakeUp() {
    setBedMenuOpen(false);
    if (actionResetTimerRef.current) clearTimeout(actionResetTimerRef.current);
    if (userSeatRef.current === "bed") {
      moveCharacterAlong("user", 0.56, 0.46, {
        finalAction: "idle",
        finalFacingLeft: false,
        seat: "none",
      });
    }
    if (compSeatRef.current === "bed") {
      moveCharacterAlong("companion", 0.45, 0.46, {
        finalAction: "idle",
        finalFacingLeft: false,
        seat: "none",
      });
    }
  }

  function handleSlotPress(interactive?: "sofa" | "bed" | "diary" | "pet") {
    if (interactive === "sofa") {
      setBedMenuOpen(false);
      handleSitTogether();
    } else if (interactive === "bed") {
      setBedMenuOpen((v) => !v);
    } else if (interactive === "pet") {
      bounceAnim(petBounce);
      showSpeech("嘘，小猫在晒太阳打盹呢～", "companion", 0.56, 0.36);
      spawnHeart(stage.w * 0.57, stage.h * 0.24);
    } else if (interactive === "diary") {
      bounceAnim(diaryBounce);
      showSpeech("桌上的小日记本很快就能翻看啦", "companion", 0.58, 0.68);
      onActionTriggered?.("diary");
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
  const compSprites = isCompanionView ? GIRL_SPRITES : BOY_SPRITES;
  const userSprites = isCompanionView ? BOY_SPRITES : GIRL_SPRITES;

  const zFromY = (yFrac: number) => Math.round(yFrac * 100);
  const revealScale = roomReveal.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] });
  const modeRotate = modeSpin.interpolate({ inputRange: [0, 1], outputRange: ["-24deg", "0deg"] });

  // Unified bubble clamped cleanly inside frame bounds
  const speechLeft = roomSpeech
    ? Math.max(14, Math.min(stage.w - 178, roomSpeech.nx * stage.w - 82))
    : 0;
  const speechTop = roomSpeech
    ? Math.max(16, Math.min(stage.h - 102, roomSpeech.ny * stage.h - charH - 42))
    : 0;

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

          if (slot.interactive) {
            const scaleAnim =
              slot.interactive === "pet"
                ? petBounce
                : slot.interactive === "diary"
                  ? diaryBounce
                  : undefined;

            return (
              <Pressable
                key={slot.id}
                style={boxStyle}
                onPress={() => handleSlotPress(slot.interactive)}
                accessibilityRole="button"
                accessibilityLabel={slot.name}
              >
                <Animated.View style={[styles.fillImg, scaleAnim ? { transform: [{ scale: scaleAnim }] } : undefined]}>
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

        {/* Companion Pixel Character */}
        <Animated.View
          style={[
            styles.spriteWrap,
            {
              width: charW,
              height: charH,
              zIndex: compAction === "sleep" ? 54 : compAction === "sit" ? 66 : zFromY(compSortY) + 1,
              transform: [
                { translateX: Animated.subtract(compX, charW / 2) },
                { translateY: Animated.subtract(compY, charH) },
                { translateY: idleFloatB },
              ],
            },
          ]}
        >
          <Pressable
            onPress={handleWave}
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

        {/* Unified non-overlapping speech bubble overlay */}
        {roomSpeech && (
          <View
            pointerEvents="none"
            style={[
              styles.unifiedBubble,
              roomSpeech.sender === "user" && styles.unifiedBubbleUser,
              { left: speechLeft, top: speechTop },
            ]}
          >
            <Text
              style={[
                styles.speechText,
                roomSpeech.sender === "user" && styles.speechTextUser,
              ]}
              numberOfLines={2}
            >
              {roomSpeech.text}
            </Text>
          </View>
        )}

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

        {/* Contextual Glass Menu above the bed when tapped */}
        {bedMenuOpen && (
          <View
            style={[
              styles.bedMenuWrap,
              {
                left: Math.max(12, stage.w * 0.06),
                top: Math.max(14, stage.h * 0.145),
              },
            ]}
          >
            <LiquidGlassSurface glass tint={nightMode ? "dark" : "light"} borderRadius={RADIUS.pill}>
              <View style={styles.bedMenuRow}>
                {someoneSleeping ? (
                  <Pressable
                    onPress={handleWakeUp}
                    style={({ pressed }) => [styles.actionItem, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons name="sunny-outline" size={13} color={PEARL_UI.accentInk} />
                    <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>起身</Text>
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      onPress={handleRestSolo}
                      style={({ pressed }) => [styles.actionItem, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name="moon-outline" size={13} color={PEARL_UI.accentInk} />
                      <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>休息一下</Text>
                    </Pressable>
                    <View style={styles.actionDivider} />
                    <Pressable
                      onPress={handleRestTogether}
                      style={({ pressed }) => [styles.actionItem, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name="bed-outline" size={13} color={PEARL_UI.accentInk} />
                      <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>一起睡</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </LiquidGlassSurface>
          </View>
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

        {/* Bottom-right Liquid Glass Action Bar */}
        <View style={styles.actionBarWrap}>
          <LiquidGlassSurface glass tint={nightMode ? "dark" : "light"} borderRadius={RADIUS.pill}>
            <View style={styles.actionBar}>
              <Pressable
                onPress={handleWave}
                style={({ pressed }) => [styles.actionItem, pressed && { transform: [{ scale: 0.90 }], opacity: 0.72 }]}
              >
                <Ionicons name="hand-left-outline" size={13} color={nightMode ? "#F8FAFC" : PEARL_UI.ink} />
                <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>打招呼</Text>
              </Pressable>
              <View style={styles.actionDivider} />
              <Pressable
                onPress={handleSitTogether}
                style={({ pressed }) => [styles.actionItem, pressed && { transform: [{ scale: 0.90 }], opacity: 0.72 }]}
              >
                <Ionicons name="bed-outline" size={13} color={nightMode ? "#F8FAFC" : PEARL_UI.ink} />
                <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>一起坐</Text>
              </Pressable>
              <View style={styles.actionDivider} />
              <Pressable
                onPress={handleSnuggle}
                style={({ pressed }) => [styles.actionItem, pressed && { transform: [{ scale: 0.90 }], opacity: 0.72 }]}
              >
                <Ionicons name="heart-outline" size={13} color={nightMode ? "#F9A8D4" : "#C87D87"} />
                <Text style={[styles.actionText, nightMode && styles.actionTextDark]}>贴贴</Text>
              </Pressable>
            </View>
          </LiquidGlassSurface>
        </View>
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
  unifiedBubble: {
    position: "absolute",
    zIndex: 120,
    width: 164,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.98)",
    shadowColor: "#5C544B",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.11,
    shadowRadius: 8,
    elevation: 3,
  },
  unifiedBubbleUser: {
    backgroundColor: "rgba(180, 192, 212, 0.92)",
    borderColor: "rgba(255, 255, 255, 0.85)",
  },
  speechText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: PEARL_UI.ink,
    textAlign: "center",
  },
  speechTextUser: { color: PEARL_UI.accentInk },
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
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    paddingVertical: 7,
    gap: 8,
  },
  actionItem: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 2 },
  actionDivider: { width: 1, height: 12, backgroundColor: "rgba(122, 118, 114, 0.25)" },
  actionText: { fontSize: 11.5, fontWeight: "600", color: PEARL_UI.ink },
  actionTextDark: { color: "#F8FAFC" },
  bedMenuWrap: { position: "absolute", zIndex: 132 },
  bedMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 8,
  },
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
