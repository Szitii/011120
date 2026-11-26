import { memo, useEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { BED_QUILT_OVERLAY, BOY_SPRITES, DUO_COMPANION_PAT_SPRITES, DUO_SPRITES, GIRL_SPRITES, ROOM_BASE_IMAGE, ROOM_SLOTS, SOFA_FRONT, type CharacterAction, type RoomImage } from "../room/roomSlots";
import { BED_FLOOR_EDGE, DUO_SLOT, SOFA_SLOT, type ActorId } from "../room/geometry";
import { RoomEngine, type ActorFrame } from "../room/roomEngine";
import { useAppIsActive } from "../state/useAppIsActive";
import { useSkin } from "../theme/SkinProvider";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { PearlTransitionLoader } from "./PearlTransitionLoader";

const ACTIONS = [["WAVE", "挥手"], ["PAT_HEAD", "摸头"], ["HUG", "抱抱"], ["CUDDLE", "贴贴"]] as const;
const ACTOR_IDS = ["companion", "user"] as const;
const WALK = ["walk_1", "walk_2", "walk_3", "walk_4"] as const;
const WALK_FRONT = ["walk_front_1", "walk_front_2", "walk_front_3", "walk_front_4"] as const;
const WALK_BACK = ["walk_back_1", "walk_back_2", "walk_back_3", "walk_back_4"] as const;
const SOFA = ROOM_SLOTS.find(slot => slot.id === "slot_sofa")!;
const BED = ROOM_SLOTS.find(slot => slot.id === "slot_bed")!;
const PET = ROOM_SLOTS.find(slot => slot.interactive === "pet")!;
const DIARY = ROOM_SLOTS.find(slot => slot.interactive === "diary")!;
const STATIC_IMAGES = [ROOM_BASE_IMAGE, ...ROOM_SLOTS.map(slot => slot.source), SOFA_FRONT, BED_QUILT_OVERLAY];
const REQUIRED_IMAGES = new Set([...STATIC_IMAGES, ...Object.values(BOY_SPRITES), ...Object.values(GIRL_SPRITES), ...Object.values(DUO_SPRITES).flat(), ...DUO_COMPANION_PAT_SPRITES]).size;
type Size = { width: number; height: number };

const depth = (ny: number) => Math.round(ny * 1000);
const box = (size: Size, left: number, top: number, width: number, height: number) => ({
  position: "absolute" as const, left: Math.round(size.width * left), top: Math.round(size.height * top),
  width: Math.round(size.width * width), height: Math.round(size.height * height),
});

const SceneImage = memo(function SceneImage({ source, onLoad }: { source: RoomImage; onLoad: (source: RoomImage) => void }) {
  return <Image source={source} style={StyleSheet.absoluteFill} contentFit="contain" transition={0}
    cachePolicy="memory" onLoad={() => onLoad(source)} />;
});

const Furniture = memo(function Furniture({ size, onLoad }: { size: Size; onLoad: (source: RoomImage) => void }) {
  return <>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}><SceneImage source={ROOM_BASE_IMAGE} onLoad={onLoad} /></View>
    {ROOM_SLOTS.map(slot => {
      const zIndex = slot.layer === "floor_base" ? 2 : slot.layer === "wall_back" ? 6 : depth(slot.sortY);
      return <View key={slot.id} pointerEvents="none" style={[box(size, slot.left, slot.top, slot.width, slot.height), { zIndex }]}>
        <SceneImage source={slot.source} onLoad={onLoad} />
      </View>;
    })}
  </>;
});

const SpriteFrames = memo(function SpriteFrames({ sources, current, onLoad }: {
  sources: Record<string, RoomImage>; current: string; onLoad: (source: RoomImage) => void;
}) {
  return <>{Object.entries(sources).map(([key, source]) => <View key={key} pointerEvents="none"
    style={[StyleSheet.absoluteFill, { opacity: key === current ? 1 : 0 }]}>
    <SceneImage source={source} onLoad={onLoad} />
  </View>)}</>;
});

const DUO_TEXTURES = Object.fromEntries([
  ...Object.entries(DUO_SPRITES).flatMap(([action, images]) => images.map((source, index) => [`${action}:${index}`, source])),
  ...DUO_COMPANION_PAT_SPRITES.map((source, index) => [`PAT_HEAD_COMPANION:${index}`, source]),
]);

function spriteFor(frame: ActorFrame): CharacterAction {
  if (frame.phase === "WALK") {
    if (frame.facingDir === "front") return WALK_FRONT[frame.step];
    if (frame.facingDir === "back") return WALK_BACK[frame.step];
    return WALK[frame.step];
  }
  if (frame.phase === "SLEEP") return "sleep";
  if (frame.phase === "SIT") return "sit";
  return frame.wave ? "wave" : "idle";
}

export function PearlInteractiveRoom({ companionName, isCompanionView, isActive = true, externalAction, companionSpeech, onAction, onOpenDiary, onCapture, capturing = false }: {
  companionName: string;
  isCompanionView: boolean;
  isActive?: boolean;
  externalAction?: { key: number; action: CompanionAction } | null;
  companionSpeech?: string | null;
  onAction?: (action: CompanionAction) => void;
  onOpenDiary?: () => void;
  onCapture?: (scene: ComponentRef<typeof View>) => void;
  capturing?: boolean;
}) {
  const { skin, ui } = useSkin();
  const appActive = useAppIsActive();
  const [engine] = useState(() => new RoomEngine());
  const [frame, setFrame] = useState(() => engine.snapshot());
  const [size, setSize] = useState<Size>({ width: 344, height: 430 });
  const [night, setNight] = useState(false);
  const [menu, setMenu] = useState(false);
  const [ready, setReady] = useState(false);
  const scene = useRef<ComponentRef<typeof View>>(null);
  const loaded = useRef(new Set<RoomImage>());
  const [onLoad] = useState(() => (source: RoomImage) => {
    loaded.current.add(source);
    if (loaded.current.size === REQUIRED_IMAGES) setReady(true);
  });
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const lastExternalKey = useRef(0);
  const awake = isActive && appActive;
  const sleeping = Object.values(frame.actors).some(actor => actor.phase === "SLEEP");

  useEffect(() => {
    if (!externalAction || externalAction.key === lastExternalKey.current || !awake || !ready) return;
    lastExternalKey.current = externalAction.key;
    engine.action(externalAction.action, "COMPANION");
  }, [awake, engine, externalAction, ready]);

  useEffect(() => {
    if (!awake || !ready) return;
    let last: number | undefined;
    let raf = 0;
    const animate = (now: number) => {
      engine.tick(last === undefined ? 0 : now - last, !isCompanionView && !menu && !capturing);
      last = now;
      if (engine.consumeChange()) setFrame(engine.snapshot());
      for (const action of engine.takeStartedActions()) actionRef.current?.(action);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [awake, capturing, engine, isCompanionView, menu, ready]);

  function interact() {
    if (!awake || !ready || isCompanionView || sleeping) return;
    setMenu(open => !open);
  }

  // `incoming` is the pose fading in during a crossfade; it needs only its one image.
  const renderActor = (id: ActorId, actor: ActorFrame = frame.actors[id], incoming = false) => {
    const action = spriteFor(actor);
    const sprites = (id === "user") !== isCompanionView ? GIRL_SPRITES : BOY_SPRITES;
    const mirrored = actor.phase === "WALK" && (
      actor.facingDir === "side" && actor.facingLeft
      || actor.facingDir === "front" && actor.step === 3 && sprites === GIRL_SPRITES
    );
    const inBed = actor.furniture === "bed" && actor.point.ny < BED_FLOOR_EDGE;
    const beforeSofaFront = actor.furniture === "sofa" && actor.point.ny < SOFA_SLOT.top + SOFA_SLOT.height;
    const zIndex = inBed ? 530 : beforeSofaFront ? 660 : depth(actor.point.ny) + 1;
    // All poses share the same canvas and foot baseline.
    const height = .175;
    const width = height;
    const key = incoming ? `${id}-incoming` : id;
    return <View key={key} testID={`room-actor-${key}`} pointerEvents="none" style={[box(size, actor.point.nx - width / 2,
      actor.point.ny - height * .973, width, height), {
      zIndex, opacity: frame.duo ? 0 : actor.opacity ?? 1,
      transform: [{ scaleX: mirrored ? -1 : 1 }],
    }]}>
      {incoming ? <SceneImage source={sprites[action]} onLoad={onLoad} />
        : <SpriteFrames sources={sprites} current={action} onLoad={onLoad} />}
    </View>;
  };

  const companion = frame.actors.companion.point;
  const labelColor = night ? ui.onDark : skin.colors.ink;
  return <View style={[styles.frame, { borderColor: skin.colors.border, backgroundColor: skin.colors.canvas }]}
    onLayout={event => {
      const { width, height } = event.nativeEvent.layout;
      if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    }}>
    <View ref={scene} collapsable={false} testID="home-room-scene" style={StyleSheet.absoluteFill}>
      <Furniture size={size} onLoad={onLoad} />
      {renderActor("companion")}
      {renderActor("user")}
      {ACTOR_IDS.map(id => frame.actors[id].incoming && renderActor(id, frame.actors[id].incoming, true))}
      <View pointerEvents="none" style={[box(size, SOFA.left, SOFA.top, SOFA.width, SOFA.height), { zIndex: 680 }]}>
        <SceneImage source={SOFA_FRONT} onLoad={onLoad} />
      </View>
      <View pointerEvents="none" style={[box(size, BED.left, BED.top, BED.width, BED.height), { zIndex: 531 }]}>
        <SceneImage source={BED_QUILT_OVERLAY} onLoad={onLoad} />
      </View>
      <View testID="room-duo-sprite" pointerEvents="none" style={[box(size, DUO_SLOT.left, DUO_SLOT.top, DUO_SLOT.width, DUO_SLOT.height), { zIndex: depth(DUO_SLOT.top + DUO_SLOT.height) + 1 }]}>
        <SpriteFrames sources={DUO_TEXTURES} current={frame.duo ? `${frame.duo.initiator === "COMPANION" && frame.duo.action === "PAT_HEAD" ? "PAT_HEAD_COMPANION" : frame.duo.action}:${frame.duo.frame}` : ""} onLoad={onLoad} />
      </View>
      {night && <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.night, { backgroundColor: ui.roomNight }]} />}
      {sleeping && <Text style={[styles.zzz, { left: size.width * .25, top: size.height * .235,
        opacity: .5 + Math.sin(frame.time / 400) * .3, color: labelColor }]}>Zzz</Text>}
      {frame.effects.map(effect => <View key={effect.id} pointerEvents="none"
        style={[styles.effect, { left: size.width * effect.point.nx - 14, top: size.height * effect.point.ny - 12,
          opacity: 1 - effect.progress, transform: [{ scale: .6 + effect.progress }] }]}>
        {effect.type === "heart" ? <Ionicons name="heart" size={20} color={ui.affection} />
          : <View style={[styles.ripple, { borderColor: skin.colors.accent }]} />}
      </View>)}
      {companionSpeech && <View pointerEvents="none" style={[styles.speechBubble, {
        left: Math.max(12, Math.min(size.width - 188, size.width * companion.nx - 88)),
        top: Math.max(12, size.height * companion.ny - 118),
        backgroundColor: skin.colors.canvas,
        borderColor: skin.colors.border,
      }]}>
        <Text numberOfLines={3} style={[styles.speechText, { color: skin.colors.ink }]}>{companionSpeech}</Text>
      </View>}
    </View>

    {ready && awake && <>
      <Pressable accessibilityLabel="点击木地板走动" style={styles.hitLayer}
        onPress={event => {
          // Web Pressable delivers click offsets on the empty hit layer.
          const tap = event.nativeEvent as typeof event.nativeEvent & { offsetX?: number; offsetY?: number };
          const x = tap.locationX ?? tap.offsetX;
          const y = tap.locationY ?? tap.offsetY;
          if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
          setMenu(false);
          engine.floor({ nx: x / size.width, ny: y / size.height });
        }} />
      <Pressable accessibilityRole="button" accessibilityLabel={sleeping ? "从床上起身" : "在床上休息"}
        style={[box(size, BED.left, BED.top, BED.width, BED.height), styles.target]}
        onPress={() => { setMenu(false); engine.furniture("bed"); }} />
      <Pressable accessibilityRole="button" accessibilityLabel="在沙发一起坐"
        style={[box(size, SOFA.left, SOFA.top, SOFA.width, SOFA.height), styles.target]}
        onPress={() => { setMenu(false); engine.furniture("sofa"); }} />
      {!isCompanionView && !sleeping && !frame.duo && <Pressable accessibilityRole="button" accessibilityState={{ expanded: menu }}
        accessibilityLabel={`与 ${companionName} 互动`} onPress={interact}
        style={[box(size, companion.nx - .05, companion.ny - .15, .1, .14), styles.actorTarget]} />}
      <Pressable accessibilityRole="button" accessibilityLabel="窗台小猫"
        style={[box(size, PET.left - .014, PET.top, PET.width + .028, PET.height), styles.objectTarget]}
        onPress={() => engine.addEffect("heart", { nx: PET.left + PET.width / 2, ny: PET.top })} />
      {onOpenDiary && <Pressable accessibilityRole="button" accessibilityLabel="粉色日记本"
        style={[box(size, DIARY.left - .024, DIARY.top - .02, DIARY.width + .048, DIARY.height + .04), styles.objectTarget]}
        onPress={onOpenDiary} />}
    </>}

    <View style={styles.tools}>
      {onCapture && <Pressable accessibilityRole="button" accessibilityLabel="拍一张小家照片"
        disabled={!awake || !ready || capturing} onPress={() => { if (scene.current) onCapture(scene.current); }}>
        <LiquidGlassSurface glass><View style={styles.icon}><Ionicons name="camera-outline" size={19} color={labelColor} /></View></LiquidGlassSurface>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="切换昼夜光线" onPress={() => setNight(value => !value)}>
        <LiquidGlassSurface glass tint={night ? "dark" : "light"}>
          <View style={styles.icon}><Ionicons name={night ? "moon" : "sunny-outline"} size={17} color={labelColor} /></View>
        </LiquidGlassSurface>
      </Pressable>
    </View>

    {ready && (sleeping || !isCompanionView) && <View style={styles.menu}>
      <LiquidGlassSurface glass tint={night ? "dark" : "light"}>
        <View style={styles.actionRow}>
          {menu && !sleeping && ACTIONS.map(([action, label]) => <Pressable key={action}
            accessibilityRole="button" style={styles.action} onPress={() => { setMenu(false); engine.action(action); }}>
            <Text style={{ color: labelColor }}>{label}</Text>
          </Pressable>)}
          <Pressable accessibilityRole="button" accessibilityLabel={sleeping ? "起身" : "互动"} accessibilityState={{ expanded: menu }}
            style={styles.action} onPress={sleeping ? () => engine.wake() : interact}>
            <Ionicons name={sleeping ? "sunny-outline" : "heart-outline"} size={15} color={labelColor} />
            <Text style={{ color: labelColor }}>{sleeping ? "起身" : "互动"}</Text>
          </Pressable>
        </View>
      </LiquidGlassSurface>
    </View>}
    <PearlTransitionLoader visible={!ready} borderRadius={28} />
  </View>;
}

const styles = StyleSheet.create({
  frame: { width: "100%", aspectRatio: .8, borderRadius: 28, borderWidth: 1, overflow: "hidden" },
  night: { zIndex: 950 },
  zzz: { position: "absolute", zIndex: 960, fontSize: 14, fontWeight: "700" },
  effect: { position: "absolute", zIndex: 970 },
  speechBubble: {
    position: "absolute",
    zIndex: 965,
    maxWidth: 176,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  speechText: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  ripple: { width: 28, height: 17, borderWidth: 1.5, borderRadius: 16 },
  hitLayer: { ...StyleSheet.absoluteFill, zIndex: 1000 },
  target: { zIndex: 1001 },
  actorTarget: { zIndex: 1002 },
  objectTarget: { zIndex: 1003, minHeight: 36, minWidth: 36 },
  tools: { position: "absolute", top: 12, right: 12, zIndex: 1050, flexDirection: "row", gap: 8 },
  icon: { width: 38, height: 38, justifyContent: "center", alignItems: "center" },
  menu: { position: "absolute", right: 12, bottom: 12, zIndex: 1050 },
  actionRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  action: { flexDirection: "row", alignItems: "center", minHeight: 40, paddingHorizontal: 10, gap: 4 },
});
