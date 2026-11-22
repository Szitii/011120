import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { createClientBootstrap } from "./src/adapters";
import { safeClientMessage } from "./src/adapters/real-api";
import type {
  ActiveIdentityContext,
  CompanionProfile,
  EncounterDetail,
  LifeContinuityCollection,
  LifeContinuityItem,
  OwnerCompanionCollection,
  OwnerCompanionSummary,
  WorldCollection,
  WorldItem,
} from "./src/contracts";
import { ViewerSensitiveCache } from "./src/state/cache";
import { toStage1MediaPresentation } from "./src/media";
import {
  BringCompanionScreen,
  ControlsScreen,
  SocialActivationScreen,
} from "./src/stage1-surfaces";
import {
  initialNavigationState,
  popRoute,
  pushRoute,
  saveScroll,
  scrollKey,
  selectTab,
  type NavigationState,
} from "./src/state/navigation";
import { SkinProvider, useSkin } from "./src/theme/SkinProvider";
import { CHROME } from "./src/theme/layoutTokens";
import { FloatingGlassTabs } from "./src/components/FloatingGlassTabs";
import { InteractiveFullRoom } from "./src/components/InteractiveFullRoom";
import { GlassChatBubble } from "./src/components/GlassChatBubble";
import { LiquidGlassSurface } from "./src/components/LiquidGlassSurface";

type LoadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "success"; value: T }
  | { kind: "empty" }
  | { kind: "error"; title: string; retry: boolean };

const cache = new ViewerSensitiveCache();

const LOCAL_PREVIEW_IMAGES: Record<string, number> = {
  "rainy-cafe": require("./assets/post-rainy-cafe.jpg"),
  "night-desk": require("./assets/post-night-desk.jpg"),
  "cute-room": require("./assets/room-cute-flat.jpg"),
};

function actionAllowed(capabilities: Record<string, boolean>, ...keys: string[]): boolean {
  return keys.some((key) => capabilities[key] === true);
}

function formatDate(value: string): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function identityLabel(identity?: ActiveIdentityContext): string {
  return identity?.activeSubject.presentation.displayName ?? "本人";
}

export default function App() {
  return (
    <SkinProvider initialSkinId="default">
      <AppShell />
    </SkinProvider>
  );
}

function AppShell() {
  const { skin } = useSkin();
  const bootstrap = useMemo(() => {
    try {
      return { value: createClientBootstrap() } as const;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Client configuration error",
      } as const;
    }
  }, []);

  const [nav, setNav] = useState<NavigationState>(initialNavigationState);
  const [identity, setIdentity] = useState<LoadState<ActiveIdentityContext>>({ kind: "loading" });
  const [world, setWorld] = useState<LoadState<WorldCollection>>({ kind: "idle" });
  const [encounter, setEncounter] = useState<LoadState<EncounterDetail>>({ kind: "idle" });
  const [profile, setProfile] = useState<LoadState<CompanionProfile>>({ kind: "idle" });
  const [life, setLife] = useState<LoadState<LifeContinuityCollection>>({ kind: "idle" });
  const [ownerCompanions, setOwnerCompanions] = useState<LoadState<OwnerCompanionCollection>>({ kind: "idle" });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [momentMode, setMomentMode] = useState(false);
  const [identitySwitchPending, setIdentitySwitchPending] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [mySettingsOpen, setMySettingsOpen] = useState(false);
  const [companionDisplayName, setCompanionDisplayName] = useState("我的家机");
  const worldScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const identityEpochRef = useRef(0);

  const route = nav.stack[nav.stack.length - 1] ?? {
    type: "root" as const,
    tab: "world" as const,
  };
  const identityValue = identity.kind === "success" ? identity.value : undefined;
  const identityId = identityValue?.activeSubject.id ?? "anonymous";

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if ("error" in bootstrap) return;
    void loadIdentityOwner();
  }, [bootstrap]);

  useEffect(() => {
    if ("error" in bootstrap || identity.kind !== "success") return;
    if (route.type === "root" && route.tab === "world") void loadWorld();
    if (route.type === "life-archive" || (route.type === "root" && route.tab === "home")) void loadLife();
    if (
      route.type === "root" &&
      route.tab === "my" &&
      identity.value.activeSubject.kind === "COMPANION"
    ) {
      void loadProfile(identity.value.activeSubject.id);
    }
    if (route.type === "encounter" || route.type === "identity-context") {
      void loadEncounter(route.encounterId);
    }
    if (route.type === "profile") void loadProfile(route.companionId);
  }, [
    route.type,
    route.type === "root" ? route.tab : "",
    route.type === "encounter" || route.type === "identity-context" ? route.encounterId : "",
    route.type === "profile" ? route.companionId : "",
    identity.kind === "success" ? identity.value.activeSubject.id : "",
  ]);

  async function loadIdentityOwner() {
    if ("error" in bootstrap) return;
    setIdentity({ kind: "loading" });
    try {
      const value = await bootstrap.value.api.identityContext();
      setIdentity({ kind: "success", value });
      void loadOwnerCompanions();
      if (bootstrap.value.sample_companionCompanionId) {
        try {
          const ownCompanion = await bootstrap.value.api.companionProfile(
            bootstrap.value.sample_companionCompanionId,
          );
          setCompanionDisplayName(ownCompanion.displayName);
        } catch {
          // The Stage 1 shell can still operate without a resolved display name.
        }
      }
    } catch (error) {
      const safe = safeClientMessage(error);
      setIdentity({ kind: "error", ...safe });
    }
  }

  async function loadOwnerCompanions() {
    if ("error" in bootstrap) return;
    setOwnerCompanions({ kind: "loading" });
    try {
      const value = await bootstrap.value.api.ownerCompanions();
      setOwnerCompanions(value.items.length ? { kind: "success", value } : { kind: "empty" });
    } catch (error) {
      const safe = safeClientMessage(error);
      setOwnerCompanions({ kind: "error", ...safe });
    }
  }

  async function loadWorld() {
    if ("error" in bootstrap) return;
    const epoch = identityEpochRef.current;
    setWorld({ kind: "loading" });
    try {
      const cached = cache.get<WorldCollection>("world");
      if (cached) {
        if (epoch === identityEpochRef.current) setWorld(cached.items.length ? { kind: "success", value: cached } : { kind: "empty" });
        return;
      }
      const value = await bootstrap.value.api.worldItems();
      if (epoch !== identityEpochRef.current) return;
      cache.set("world", value);
      setWorld(value.items.length ? { kind: "success", value } : { kind: "empty" });
      requestAnimationFrame(() => {
        const y = nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0;
        worldScrollRef.current?.scrollTo({ y, animated: !reducedMotion });
      });
    } catch (error) {
      if (epoch !== identityEpochRef.current) return;
      const safe = safeClientMessage(error);
      setWorld({ kind: "error", ...safe });
    }
  }

  async function loadLife() {
    if ("error" in bootstrap) return;
    const epoch = identityEpochRef.current;
    setLife({ kind: "loading" });
    try {
      const viewer =
        identityValue && identityValue.activeSubject.kind !== "OWNER"
          ? { kind: identityValue.activeSubject.kind, id: identityValue.activeSubject.id }
          : undefined;
      const viewerKey = viewer ? `${viewer.kind}:${viewer.id}` : "OWNER";
      const key = `life-continuity:${viewerKey}`;
      const cached = cache.get<LifeContinuityCollection>(key);
      if (cached) {
        if (epoch === identityEpochRef.current) setLife(cached.items.length ? { kind: "success", value: cached } : { kind: "empty" });
        return;
      }
      const value = await bootstrap.value.api.lifeContinuity(viewer);
      if (epoch !== identityEpochRef.current) return;
      cache.set(key, value);
      setLife(value.items.length ? { kind: "success", value } : { kind: "empty" });
    } catch (error) {
      if (epoch !== identityEpochRef.current) return;
      const safe = safeClientMessage(error);
      setLife({ kind: "error", ...safe });
    }
  }

  async function loadEncounter(id: string) {
    if ("error" in bootstrap) return;
    const epoch = identityEpochRef.current;
    setEncounter({ kind: "loading" });
    try {
      const key = `encounter:${id}`;
      const value =
        cache.get<EncounterDetail>(key) ?? (await bootstrap.value.api.encounterDetail(id));
      if (epoch !== identityEpochRef.current) return;
      cache.set(key, value);
      setEncounter({ kind: "success", value });
    } catch (error) {
      if (epoch !== identityEpochRef.current) return;
      const safe = safeClientMessage(error);
      setEncounter({ kind: "error", ...safe });
    }
  }

  async function loadProfile(id: string) {
    if ("error" in bootstrap) return;
    const epoch = identityEpochRef.current;
    setProfile({ kind: "loading" });
    try {
      const viewer =
        identityValue && identityValue.activeSubject.kind !== "OWNER"
          ? { kind: identityValue.activeSubject.kind, id: identityValue.activeSubject.id }
          : undefined;
      const viewerKey = viewer ? `${viewer.kind}:${viewer.id}` : "OWNER";
      const key = `profile:${viewerKey}:${id}`;
      const value =
        cache.get<CompanionProfile>(key) ?? (await bootstrap.value.api.companionProfile(id, viewer));
      if (epoch !== identityEpochRef.current) return;
      cache.set(key, value);
      setProfile({ kind: "success", value });
    } catch (error) {
      if (epoch !== identityEpochRef.current) return;
      const safe = safeClientMessage(error);
      setProfile({ kind: "error", ...safe });
    }
  }

  async function switchIdentity(target:
    | { kind: "OWNER" }
    | { kind: "COMPANION"; id: string; displayName: string }
  ) {
    if ("error" in bootstrap) return;
    const previousIdentity = identityValue;
    const previousName = companionDisplayName;

    setSwitcherOpen(false);
    identityEpochRef.current += 1;
    setIdentitySwitchPending(true);
    setIdentity({ kind: "loading" });
    setWorld({ kind: "idle" });
    setLife({ kind: "idle" });
    setEncounter({ kind: "idle" });
    setProfile({ kind: "idle" });
    cache.purgeViewerSensitive();

    try {
      const value =
        target.kind === "OWNER"
          ? await bootstrap.value.api.identityContext()
          : await bootstrap.value.api.identityContext({
              kind: "COMPANION",
              id: target.id,
            });
      if (target.kind === "COMPANION") setCompanionDisplayName(target.displayName);
      setIdentity({ kind: "success", value });
      setNav((current) => selectTab(current, current.rootTab));
    } catch (error) {
      const safe = safeClientMessage(error);
      if (previousIdentity) {
        try {
          const restored =
            previousIdentity.activeSubject.kind === "OWNER"
              ? await bootstrap.value.api.identityContext()
              : await bootstrap.value.api.identityContext({
                  kind: previousIdentity.activeSubject.kind,
                  id: previousIdentity.activeSubject.id,
                });
          setCompanionDisplayName(previousName);
          setIdentity({ kind: "success", value: restored });
        } catch {
          setIdentity({ kind: "error", ...safe });
        }
      } else {
        setIdentity({ kind: "error", ...safe });
      }
    } finally {
      setIdentitySwitchPending(false);
    }
  }

  async function switchCompanionFromUi(item: OwnerCompanionSummary) {
    if (!item.socialReady || "error" in bootstrap) return;
    if (route.type === "encounter") {
      await switchToCompanionContext(item);
      return;
    }
    await switchIdentity({
      kind: "COMPANION",
      id: item.companionId,
      displayName: item.displayName,
    });
  }

  function openEncounter(item: WorldItem) {
    if (item.source.type !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true) return;
    const y = nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0;
    setNav((current) =>
      pushRoute(current, {
        type: "encounter",
        encounterId: item.source.id,
        sourceTab: "world",
        sourceScrollY: y,
        ...(item.author.companionId ? { companionId: item.author.companionId } : {}),
      }),
    );
  }

  function openProfile(companionId: string, source: "WORLD_ACTOR" | "ENCOUNTER" | "OWNER_ROSTER", fromEncounterId?: string) {
    setNav((current) =>
      pushRoute(current, {
        type: "profile",
        companionId,
        source,
        ...(fromEncounterId ? { fromEncounterId } : {}),
      }),
    );
  }

  function openProfileFromEncounter() {
    if (route.type !== "encounter" || !route.companionId) return;
    openProfile(route.companionId, "ENCOUNTER", route.encounterId);
  }

  async function switchToCompanionContext(item: OwnerCompanionSummary) {
    if ("error" in bootstrap || route.type !== "encounter" || !item.socialReady) {
      return;
    }
    const previousIdentity = identityValue;
    const previousName = companionDisplayName;

    identityEpochRef.current += 1;
    setIdentitySwitchPending(true);
    setIdentity({ kind: "loading" });
    setWorld({ kind: "idle" });
    setLife({ kind: "idle" });
    setEncounter({ kind: "idle" });
    setProfile({ kind: "idle" });
    cache.purgeViewerSensitive();

    try {
      const value = await bootstrap.value.api.identityContext({
        kind: "COMPANION",
        id: item.companionId,
      });
      setCompanionDisplayName(item.displayName);
      setIdentity({ kind: "success", value });
      setNav((current) =>
        pushRoute(current, {
          type: "identity-context",
          encounterId: route.encounterId,
          companionId: item.companionId,
        }),
      );
    } catch (error) {
      const safe = safeClientMessage(error);
      if (previousIdentity) {
        try {
          const restored =
            previousIdentity.activeSubject.kind === "OWNER"
              ? await bootstrap.value.api.identityContext()
              : await bootstrap.value.api.identityContext({
                  kind: previousIdentity.activeSubject.kind,
                  id: previousIdentity.activeSubject.id,
                });
          setCompanionDisplayName(previousName);
          setIdentity({ kind: "success", value: restored });
        } catch {
          setIdentity({ kind: "error", ...safe });
        }
      } else {
        setIdentity({ kind: "error", ...safe });
      }
    } finally {
      setIdentitySwitchPending(false);
    }
  }

  function goBack() {
    const previous = nav.stack[nav.stack.length - 2];
    setMomentMode(false);
    setNav((current) => popRoute(current));
    if (previous?.type === "root" && previous.tab === "world") {
      requestAnimationFrame(() => {
        const y = nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0;
        worldScrollRef.current?.scrollTo({ y, animated: !reducedMotion });
      });
    }
  }

  if ("error" in bootstrap) {
    return <Centered title="Client configuration required" body={bootstrap.error} />;
  }

  const isMoment = route.type === "encounter" && momentMode && encounter.kind === "success";
  const currentKind = identityValue?.activeSubject.kind ?? "OWNER";
  const isSampleCompanion = currentKind !== "OWNER";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: skin.colors.canvas }]}>
      <StatusBar style={skin.isDark ? "light" : "dark"} />

      {!isMoment && (
        <AppHeader
          routeIsRoot={route.type === "root"}
          rootTab={nav.rootTab}
          identityTitle={identityLabel(identityValue)}
          isSampleCompanion={isSampleCompanion}
          identity={identity}
          onBack={goBack}
          onIdentity={() => setSwitcherOpen(true)}
          onBackToOwner={() => void switchIdentity({ kind: "OWNER" })}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          onOpenComposer={() => setComposerOpen(true)}
          onOpenSettings={() => setMySettingsOpen(true)}
        />
      )}

      {route.type === "root" && route.tab === "world" && (
        <WorldScreen
          state={world}
          isSampleCompanion={isSampleCompanion}
          actorDisplayName={identityLabel(identityValue)}
          companionName={companionDisplayName}
          searchOpen={searchOpen}
          composerOpen={composerOpen}
          onCloseComposer={() => setComposerOpen(false)}
          scrollRef={worldScrollRef}
          onScroll={(y) =>
            setNav((current) => saveScroll(current, identityId, "world", y))
          }
          onOpenActor={(companionId) => openProfile(companionId, "WORLD_ACTOR")}
          onOpenEncounter={openEncounter}
          onRetry={() => void loadWorld()}
        />
      )}

      {route.type === "root" && route.tab === "home" && (
        <PrivateHomeScreen
          state={life}
          isCompanion={isSampleCompanion}
          companionId={identityValue?.activeSubject.kind === "COMPANION" ? identityValue.activeSubject.id : undefined}
          userName={identityLabel(identityValue)}
          companionName={companionDisplayName}
          isMockMode={bootstrap.value.dataMode === "mock"}
          onOpenTimeline={() => setNav((current) => pushRoute(current, { type: "life-archive" }))}
          onOpenEncounter={(item) => {
            if (item.kind !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true) return;
            setNav((current) => pushRoute(current, {
              type: "encounter",
              encounterId: item.linkedObject.id,
              sourceTab: "home",
              sourceScrollY: 0,
              ...(item.counterpart?.companionId ? { companionId: item.counterpart.companionId } : {}),
            }));
          }}
        />
      )}

      {route.type === "life-archive" && (
        <LifeScreen
          state={life}
          isCompanion={isSampleCompanion}
          activeCompanionId={
            identityValue?.activeSubject.kind === "COMPANION"
              ? identityValue.activeSubject.id
              : undefined
          }
          companionName={companionDisplayName}
          onRetry={() => void loadLife()}
          onOpenEncounter={(item) => {
            if (item.kind !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true) return;
            setNav((current) =>
              pushRoute(current, {
                type: "encounter",
                encounterId: item.linkedObject.id,
                sourceTab: "home",
                sourceScrollY: 0,
                ...(item.counterpart?.companionId ? { companionId: item.counterpart.companionId } : {}),
              }),
            );
          }}
        />
      )}

      {route.type === "root" && route.tab === "my" && (
        <MyScreen
          identity={identity}
          isSampleCompanion={isSampleCompanion}
          companionName={companionDisplayName}
          companions={ownerCompanions}
          selfProfile={profile}
          isMockMode={bootstrap.value.dataMode === "mock"}
          settingsOpen={mySettingsOpen}
          onCloseSettings={() => setMySettingsOpen(false)}
          onOpenCompanionProfile={(item) => openProfile(item.companionId, "OWNER_ROSTER")}
          onControls={(item) => {
            setCompanionDisplayName(item.displayName);
            setNav((current) => pushRoute(current, {
              type: "controls",
              companionId: item.companionId,
            }));
          }}
          onResumeCompanion={(item) => {
            setNav((current) => pushRoute(current, {
              type: "social-activation",
              companionId: item.companionId,
              identityId: item.identityId,
              displayName: item.displayName,
              approvedFields: item.approvedFields,
            }));
          }}
          onBringCompanion={() => setNav((current) => pushRoute(current, { type: "bring-companion" }))}
        />
      )}

      {route.type === "encounter" && (
        <EncounterScreen
          state={encounter}
          onRetry={() => void loadEncounter(route.encounterId)}
          onProfile={(companionId) => openProfile(companionId, "ENCOUNTER", route.encounterId)}
          onMoment={() => setMomentMode((value) => !value)}
          momentMode={momentMode}
          companionName={companionDisplayName}
        />
      )}

      {route.type === "profile" && (
        <ProfileScreen
          state={profile}
          onRetry={() => void loadProfile(route.companionId)}
          onControls={() => {
            const p = profile.kind === "success" ? profile.value : undefined;
            if (!p || p.viewer.capabilities.openControls !== true) return;
            setCompanionDisplayName(p.displayName);
            setNav((current) => pushRoute(current, { type: "controls", companionId: p.companionId }));
          }}
        />
      )}

      {route.type === "bring-companion" && (
        <BringCompanionScreen
          api={bootstrap.value.api}
          onApproved={() => void loadOwnerCompanions()}
          onResidencyChanged={() => void loadOwnerCompanions()}
          onOpenCompanion={(identity) => {
            openProfile(identity.companionId, "OWNER_ROSTER");
          }}
        />
      )}

      {route.type === "social-activation" && (
        <SocialActivationScreen
          api={bootstrap.value.api}
          companion={{
            companionId: route.companionId,
            identityId: route.identityId,
            displayName: route.displayName,
            approvedFields: route.approvedFields,
          }}
          onActivated={() => void loadOwnerCompanions()}
          onOpenCompanion={() => {
            openProfile(route.companionId, "OWNER_ROSTER");
          }}
        />
      )}

      {route.type === "controls" && (
        <ControlsScreen
          api={bootstrap.value.api}
          companionId={route.companionId}
          companionName={companionDisplayName}
        />
      )}

      {route.type === "identity-context" && (
        <CompanionContextScreen
          state={encounter}
          identity={identity}
          companionName={companionDisplayName}
          onRetry={() => void loadEncounter(route.encounterId)}
          onWorld={() => setNav((current) => selectTab(current, "world"))}
        />
      )}

      {!isMoment && route.type === "root" && (
        <FloatingGlassTabs
          current={nav.rootTab}
          isSampleCompanion={isSampleCompanion}
          onSelect={(tab) => setNav((state) => selectTab(state, tab))}
        />
      )}

      <IdentitySwitcher
        visible={switcherOpen}
        identity={identity}
        companions={ownerCompanions}
        pending={identitySwitchPending}
        onClose={() => setSwitcherOpen(false)}
        onOwner={() => void switchIdentity({ kind: "OWNER" })}
        onCompanion={(item) => void switchCompanionFromUi(item)}
      />
    </SafeAreaView>
  );
}

function AppHeader({
  routeIsRoot,
  rootTab,
  identityTitle,
  isSampleCompanion,
  identity,
  onBack,
  onIdentity,
  onBackToOwner,
  onToggleSearch,
  onOpenComposer,
  onOpenSettings,
}: {
  routeIsRoot: boolean;
  rootTab: "world" | "home" | "my";
  identityTitle: string;
  isSampleCompanion: boolean;
  identity: LoadState<ActiveIdentityContext>;
  onBack: () => void;
  onIdentity: () => void;
  onBackToOwner: () => void;
  onToggleSearch: () => void;
  onOpenComposer: () => void;
  onOpenSettings: () => void;
}) {
  const { skin } = useSkin();
  const avatar = identity.kind === "success" ? identity.value.activeSubject.presentation.avatar : undefined;
  const initial = identityTitle.slice(0, 1).toUpperCase();

  return (
    <View style={{ backgroundColor: skin.colors.canvas }}>
      <View style={[styles.topBar, { backgroundColor: skin.colors.canvas, borderBottomColor: skin.colors.border }]}>
        {routeIsRoot ? (
          <Pressable
            style={({ pressed }) => [styles.identityTrigger, pressed && { opacity: 0.75 }]}
            onPress={onIdentity}
            accessibilityRole="button"
            accessibilityLabel="切换当前账号"
          >
            {rootTab !== "my" && (
              avatar ? (
                <Image source={{ uri: avatar }} style={[styles.miniAvatarImage, { borderColor: skin.identityBadges.avatarRing, borderWidth: 2 }]} />
              ) : (
                <View
                  style={[
                    styles.miniAvatar,
                    {
                      backgroundColor: isSampleCompanion ? "#3B82F6" : skin.colors.ink,
                      borderColor: skin.identityBadges.avatarRing,
                      borderWidth: 2,
                    },
                  ]}
                >
                  <Text style={[styles.miniAvatarText, { color: "#FFFFFF" }]}>{initial}</Text>
                </View>
              )
            )}
            <Text style={[styles.brand, { color: skin.colors.ink }]} numberOfLines={1}>{identityTitle}</Text>
            <View style={[styles.headerRoleChip, { backgroundColor: skin.colors.accentSoft }]}>
              <Text style={[styles.headerRoleChipText, { color: skin.colors.accentSoftFg }]}>
                {isSampleCompanion ? "AI" : "本人"}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: skin.colors.inkMute }]}>⌄</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.iconButton} onPress={onBack}>
            <Text style={[styles.backIcon, { color: skin.colors.ink }]}>‹</Text>
          </Pressable>
        )}

        <View style={styles.headerRight}>
          {routeIsRoot && rootTab === "world" && (
            <>
              <Pressable
                onPress={onToggleSearch}
                style={({ pressed }) => [styles.headerIconBtn, { backgroundColor: skin.colors.surface }, pressed && { transform: [{ scale: 0.92 }] }]}
                accessibilityRole="button"
                accessibilityLabel="搜索动态"
              >
                <Ionicons name="search-outline" size={18} color={skin.colors.ink} />
              </Pressable>
              <Pressable
                onPress={onOpenComposer}
                style={({ pressed }) => pressed && { transform: [{ scale: 0.94 }] }}
                accessibilityRole="button"
                accessibilityLabel="发动态"
              >
                <LiquidGlassSurface variant="chip" borderRadius={999}>
                  <View style={styles.postChipInner}>
                    <Ionicons name="add" size={15} color={skin.colors.ink} />
                    <Text style={[styles.postChipText, { color: skin.colors.ink }]}>发动态</Text>
                  </View>
                </LiquidGlassSurface>
              </Pressable>
            </>
          )}
          {routeIsRoot && rootTab === "my" && (
            <Pressable
              onPress={onOpenSettings}
              style={({ pressed }) => [styles.headerIconBtn, { backgroundColor: skin.colors.surface }, pressed && { transform: [{ scale: 0.92 }] }]}
              accessibilityRole="button"
              accessibilityLabel="打开设置"
            >
              <Ionicons name="settings-outline" size={19} color={skin.colors.ink} />
            </Pressable>
          )}
          {identity.kind === "loading" && <ActivityIndicator size="small" />}
        </View>
      </View>

      {isSampleCompanion && (
        <View style={[styles.companionAnchorBar, { backgroundColor: skin.actorAnchor.companionBarBg }]}>
          <Text style={[styles.companionAnchorText, { color: skin.actorAnchor.companionBarText }]}>
            正在以 {identityTitle}（AI）视角查看 · 权限已同步
          </Text>
          <Pressable onPress={onBackToOwner} hitSlop={8}>
            <Text style={[styles.companionAnchorBack, { color: skin.actorAnchor.companionBarText }]}>
              切回本人
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function WorldScreen({
  state,
  isSampleCompanion,
  actorDisplayName,
  companionName,
  searchOpen,
  composerOpen,
  onCloseComposer,
  scrollRef,
  onScroll,
  onOpenActor,
  onOpenEncounter,
  onRetry,
}: {
  state: LoadState<WorldCollection>;
  isSampleCompanion: boolean;
  actorDisplayName: string;
  companionName: string;
  searchOpen: boolean;
  composerOpen: boolean;
  onCloseComposer: () => void;
  scrollRef: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  onScroll: (y: number) => void;
  onOpenActor: (companionId: string) => void;
  onOpenEncounter: (item: WorldItem) => void;
  onRetry: () => void;
}) {
  const { skin } = useSkin();
  const [feedTab, setFeedTab] = useState<"RECOMMEND" | "FOLLOWING">("RECOMMEND");
  const [actorFilter, setActorFilter] = useState<"ALL" | "OWNER" | "SOCIAL_TWIN">("ALL");
  const [query, setQuery] = useState("");
  const [localPosts, setLocalPosts] = useState<WorldItem[]>([]);
  const [draftText, setDraftText] = useState("");

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "idle") return <Centered title="正在准备社区内容" body="如长时间未刷新，请切换账号重试。" />;
  if (state.kind === "empty") {
    return <Centered title="公共社区还没有动态" body="发一条日常，或者等家机在授权时段分享生活片段吧。" />;
  }
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (state.kind !== "success") return <Centered title="公共社区暂时无法连接。" />;

  const allItems = [...localPosts, ...state.value.items];
  const visibleItems = allItems.filter((item) => {
    if (feedTab === "FOLLOWING" && item.visibility !== "FRIENDS" && item.author.subjectKind !== "SOCIAL_TWIN" && !item.id.startsWith("local-")) {
      return false;
    }
    if (actorFilter !== "ALL" && item.author.subjectKind !== actorFilter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${item.author.displayName} ${item.body ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  function publishLocalDraft() {
    const body = draftText.trim();
    if (!body) return;
    const newItem: WorldItem = {
      id: `local-${Date.now()}`,
      kind: "POST",
      author: {
        subjectKind: isSampleCompanion ? "SOCIAL_TWIN" : "OWNER",
        subjectId: isSampleCompanion ? "twin-local" : "owner-local",
        displayName: isSampleCompanion ? `${companionName}（Owner 代发）` : actorDisplayName,
      },
      publishedAt: new Date().toISOString(),
      body,
      source: { type: "POST", id: `local-src-${Date.now()}` },
      visibility: "PUBLIC",
      viewerCapabilities: { react: true, reply: true, share: true, openDetail: false },
      completeness: "COMPLETE",
    };
    setLocalPosts((prev) => [newItem, ...prev]);
    setDraftText("");
    onCloseComposer();
  }

  return (
    <View style={[styles.content, { backgroundColor: skin.colors.canvas }]}>
      {/* Sub-header: 推荐 / 关注 + Compact Filter Pills */}
      <View style={[styles.feedTopBar, { borderBottomColor: skin.colors.border }]}>
        <View style={styles.feedTabsRow}>
          {([
            { key: "RECOMMEND" as const, label: "推荐" },
            { key: "FOLLOWING" as const, label: "关注" },
          ]).map((t) => {
            const active = feedTab === t.key;
            return (
              <Pressable key={t.key} onPress={() => setFeedTab(t.key)} style={styles.feedTabItem}>
                <Text
                  style={[
                    styles.feedTabText,
                    { color: active ? skin.colors.ink : skin.colors.inkMute, fontWeight: active ? "700" : "500" },
                  ]}
                >
                  {t.label}
                </Text>
                {active && <View style={[styles.feedTabIndicator, { backgroundColor: skin.colors.ink }]} />}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.compactFilterRow}>
          {([
            { key: "ALL" as const, label: "全部" },
            { key: "OWNER" as const, label: "人类" },
            { key: "SOCIAL_TWIN" as const, label: "家机" },
          ]).map((f) => {
            const active = actorFilter === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setActorFilter(f.key)}
                style={[
                  styles.compactPill,
                  { backgroundColor: active ? skin.colors.accent : skin.colors.surface },
                ]}
              >
                <Text
                  style={[
                    styles.compactPillText,
                    { color: active ? skin.colors.accentFg : skin.colors.inkSub },
                  ]}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {searchOpen && (
        <View style={[styles.searchBarWrap, { borderBottomColor: skin.colors.border }]}>
          <Ionicons name="search-outline" size={16} color={skin.colors.inkMute} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索动态、话题或名字..."
            placeholderTextColor={skin.colors.inkMute}
            style={[styles.searchInput, { color: skin.colors.ink }]}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={16} color={skin.colors.inkMute} />
            </Pressable>
          )}
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        style={[styles.content, { backgroundColor: skin.colors.canvas }]}
        contentContainerStyle={[styles.feed, { paddingBottom: CHROME.scrollBottomClearance }]}
        onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={100}
      >
        {visibleItems.length === 0 ? (
          <View style={styles.feedEnd}>
            <Text style={styles.tinyMuted}>这里暂时没有匹配的动态</Text>
          </View>
        ) : (
          visibleItems.map((item, idx) => (
            <FeedItem
              key={item.id}
              item={item}
              seedLikes={idx === 0 ? 48 : idx === 1 ? 31 : 17}
              onOpenActor={item.author.companionId ? () => onOpenActor(item.author.companionId!) : undefined}
              onOpen={() => onOpenEncounter(item)}
            />
          ))
        )}

        <View style={styles.feedEnd}>
          <Text style={styles.tinyMuted}>已经到底啦</Text>
        </View>
      </ScrollView>

      {/* Post Composer Modal */}
      <Modal visible={composerOpen} transparent animationType="slide" onRequestClose={onCloseComposer}>
        <Pressable style={styles.modalBackdrop} onPress={onCloseComposer}>
          <Pressable style={[styles.sheet, { backgroundColor: skin.colors.canvas }]} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>发布新动态</Text>
            <Text style={[styles.tinyMuted, { marginBottom: 10 }]}>
              当前身份：{isSampleCompanion ? `${companionName}（将标注 Owner 代发）` : actorDisplayName}
            </Text>
            <TextInput
              value={draftText}
              onChangeText={setDraftText}
              multiline
              placeholder="随手记一句今天的小事..."
              placeholderTextColor={skin.colors.inkMute}
              style={[
                styles.composerInput,
                { backgroundColor: skin.colors.surface, borderColor: skin.colors.border, color: skin.colors.ink },
              ]}
            />
            <View style={styles.composerActions}>
              <Pressable onPress={onCloseComposer} style={[styles.composerCancel, { backgroundColor: skin.colors.surface }]}>
                <Text style={{ color: skin.colors.inkSub, fontSize: 13 }}>取消</Text>
              </Pressable>
              <Pressable onPress={publishLocalDraft} style={[styles.composerSubmit, { backgroundColor: skin.colors.accent }]}>
                <Text style={{ color: skin.colors.accentFg, fontSize: 13, fontWeight: "600" }}>发布</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function FeedItem({
  item,
  seedLikes,
  onOpenActor,
  onOpen,
}: {
  item: WorldItem;
  seedLikes: number;
  onOpenActor?: () => void;
  onOpen: () => void;
}) {
  const { skin } = useSkin();
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [comments, setComments] = useState<Array<{ who: string; text: string }>>(
    item.id === "world-preview-1" ? [{ who: "沈砚", text: "下次下班记得带伞。" }] : [],
  );

  const canOpen = item.viewerCapabilities.openDetail === true && item.source.type === "ENCOUNTER";
  const hasMedia = (item.media?.length ?? 0) > 0;
  const avatarBg = item.author.subjectKind === "OWNER" ? "#F48FA3" : "#3B82F6";

  function sendComment() {
    const clean = replyText.trim();
    if (!clean) return;
    setComments((prev) => [...prev, { who: "我", text: clean }]);
    setReplyText("");
    setReplyOpen(false);
  }

  return (
    <View style={[styles.feedItem, { borderBottomColor: skin.colors.border }]}>
      <Pressable style={styles.feedAuthorRow} disabled={!onOpenActor} onPress={onOpenActor}>
        <View style={[styles.feedAvatar, { backgroundColor: avatarBg }]}>
          <Text style={[styles.feedAvatarText, { color: "#FFFFFF" }]}>
            {item.author.displayName.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={styles.feedAuthorText}>
          <View style={styles.feedAuthorLine}>
            <Text style={[styles.feedAuthorName, { color: skin.colors.ink }]} numberOfLines={1}>
              {item.author.displayName}
            </Text>
            {item.author.subjectKind === "SOCIAL_TWIN" && (
              <View style={[styles.aiTinyBadge, { backgroundColor: skin.identityBadges.aiBadgeBg }]}>
                <Text style={[styles.aiTinyBadgeText, { color: skin.identityBadges.aiBadgeText }]}>AI</Text>
              </View>
            )}
          </View>
          <Text style={[styles.feedMeta, { color: skin.colors.inkMute }]}>{formatDate(item.publishedAt)}</Text>
        </View>
      </Pressable>

      {item.body && <Text style={[styles.feedBody, { color: skin.colors.ink }]}>{item.body}</Text>}

      {hasMedia && (
        <View style={styles.mediaStack}>
          {item.media!.map((media, index) => {
            if (media.type === "LOCAL_PREVIEW_IMAGE" && typeof media.key === "string" && LOCAL_PREVIEW_IMAGES[media.key]) {
              return (
                <Image
                  key={`${item.id}-local-${index}`}
                  source={LOCAL_PREVIEW_IMAGES[media.key]}
                  accessibilityLabel={typeof media.alt === "string" ? media.alt : "动态配图"}
                  resizeMode="cover"
                  style={styles.candidMediaImage}
                />
              );
            }
            const presentation = toStage1MediaPresentation(media);
            if (presentation.kind === "IMAGE") {
              return (
                <Image
                  key={`${item.id}-media-${index}`}
                  source={{ uri: presentation.url }}
                  accessibilityLabel={presentation.alt}
                  resizeMode="cover"
                  style={styles.candidMediaImage}
                />
              );
            }
            return null;
          })}
        </View>
      )}

      <View style={styles.feedActions}>
        <View style={styles.feedActionCluster}>
          <Pressable
            onPress={() => setLiked((v) => !v)}
            style={({ pressed }) => [styles.socialBtn, pressed && { transform: [{ scale: 0.9 }] }]}
            hitSlop={8}
          >
            <Ionicons
              name={liked ? "heart" : "heart-outline"}
              size={19}
              color={liked ? "#E11D48" : skin.colors.inkSub}
            />
            <Text style={[styles.socialCount, { color: liked ? "#E11D48" : skin.colors.inkSub }]}>
              {seedLikes + (liked ? 1 : 0)}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setReplyOpen(true)}
            style={({ pressed }) => [styles.socialBtn, pressed && { transform: [{ scale: 0.9 }] }]}
            hitSlop={8}
          >
            <Ionicons name="chatbubble-outline" size={18} color={skin.colors.inkSub} />
            <Text style={[styles.socialCount, { color: skin.colors.inkSub }]}>{comments.length}</Text>
          </Pressable>

          <Pressable
            onPress={() => setSaved((v) => !v)}
            style={({ pressed }) => [styles.socialBtn, pressed && { transform: [{ scale: 0.9 }] }]}
            hitSlop={8}
          >
            <Ionicons
              name={saved ? "bookmark" : "bookmark-outline"}
              size={18}
              color={saved ? skin.glass.iconTint : skin.colors.inkSub}
            />
          </Pressable>
        </View>


      </View>

      {comments.length > 0 && (
        <View style={[styles.commentBox, { backgroundColor: skin.colors.surface }]}>
          {comments.map((c, i) => (
            <Text key={i} style={[styles.commentLine, { color: skin.colors.inkSub }]}>
              <Text style={{ color: skin.colors.ink, fontWeight: "600" }}>{c.who}：</Text>
              {c.text}
            </Text>
          ))}
        </View>
      )}

      <Modal visible={replyOpen} transparent animationType="slide" onRequestClose={() => setReplyOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setReplyOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: skin.colors.canvas }]} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>回复 {item.author.displayName}</Text>
            <View style={styles.composerRow}>
              <TextInput
                value={replyText}
                onChangeText={setReplyText}
                placeholder="说点什么..."
                placeholderTextColor={skin.colors.inkMute}
                style={[styles.replyInput, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border, color: skin.colors.ink }]}
                returnKeyType="send"
                onSubmitEditing={sendComment}
              />
              <Pressable onPress={sendComment} style={[styles.composerSubmit, { backgroundColor: skin.colors.accent }]}>
                <Text style={{ color: skin.colors.accentFg, fontSize: 13, fontWeight: "600" }}>发送</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function EncounterScreen({
  state,
  onRetry,
  onProfile,
  onMoment,
  momentMode,
  companionName,
}: {
  state: LoadState<EncounterDetail>;
  onRetry: () => void;
  onProfile: (companionId: string) => void;
  onMoment: () => void;
  momentMode: boolean;
  companionName: string;
}) {
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (state.kind !== "success") return <Centered title="这次暂时看不了。" />;

  const e = state.value;
  const participants = [
    e.participants.find((participant) => participant.role === "INITIATOR"),
    e.participants.find((participant) => participant.role === "RESPONDER"),
  ];

  const renderParticipant = (
    participant: EncounterDetail["participants"][number] | undefined,
    fallbackName: string,
  ) => {
    const displayName =
      participant?.presentationAvailable === true && participant.displayName
        ? participant.displayName
        : fallbackName;
    const avatar = participant?.presentationAvailable === true ? participant.avatar : undefined;
    const canOpen =
      participant?.profileAvailable === true &&
      typeof participant.companionId === "string";

    return (
      <Pressable
        style={styles.participant}
        disabled={!canOpen}
        onPress={() => {
          if (canOpen && participant?.companionId) onProfile(participant.companionId);
        }}
      >
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.participantAvatarImage} />
        ) : (
          <View style={styles.participantAvatar}>
            <Text>{displayName.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.participantName} numberOfLines={2} ellipsizeMode="tail">{displayName}</Text>
        {participant?.presentationAvailable === true && participant.handle && (
          <Text style={styles.participantHandle} numberOfLines={2} ellipsizeMode="tail">@{participant.handle}</Text>
        )}
      </Pressable>
    );
  };

  return (
    <ScrollView
      style={styles.content}
      contentContainerStyle={momentMode ? styles.moment : styles.encounterPage}
    >
      {momentMode ? (
        <>
          <Text style={styles.momentBrand}>COMPANION_SOCIAL</Text>
          <Text style={styles.momentLabel}>MOMENT</Text>
          <Text style={styles.momentTitle}>{e.status}</Text>
          <Text style={styles.momentDate}>{formatDate(e.occurredAt)}</Text>
          <View style={styles.momentRule} />
          <Text style={styles.momentBody}>{e.body ?? "没留下图，也没留下话。"}</Text>
          <Pressable style={styles.secondaryPill} onPress={onMoment}>
            <Text style={styles.secondaryPillText}>回来</Text>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.encounterHero}>
            <Text style={styles.encounterKicker}>ENCOUNTER</Text>
            <Text style={styles.encounterTitle}>相遇</Text>
            <Text style={styles.encounterMeta}>{formatDate(e.occurredAt)}</Text>
          </View>

          <View style={styles.participantRail}>
            {renderParticipant(participants[0], companionName)}
            <View style={styles.connectionLine} />
            <View style={styles.encounterBadge}><Text style={styles.encounterBadgeText}>相遇</Text></View>
            <View style={styles.connectionLine} />
            {renderParticipant(participants[1], "另一位家机")}
          </View>

          <View style={styles.encounterPanel}>
            <Text style={styles.sectionLabel}>状态</Text>
            <Text style={styles.encounterStatus}>{e.status}</Text>
            <Text style={styles.bodyText}>{e.body ?? "没留下内容。状态还在。"}</Text>
            {e.completeness === "PARTIAL" && (
              <Text style={styles.warning}>有一部分没回来。</Text>
            )}
          </View>

          <View style={styles.actionStack}>
            {e.participants.some((participant) => participant.profileAvailable && participant.companionId) ? (
              <Text style={styles.tinyMuted}>点参与者头像可以查看已授权主页。</Text>
            ) : (
              <Text style={styles.tinyMuted}>参与者主页当前不可用。</Text>
            )}
            <Pressable style={styles.secondaryPill} onPress={onMoment}>
              <Text style={styles.secondaryPillText}>留一下</Text>
            </Pressable>
          </View>

          <View style={styles.traceBlock}>
            <Text style={styles.sectionLabel}>TRACE</Text>
            <Text style={styles.tinyMuted}>ID · {e.encounterId.slice(0, 8)}</Text>
            <Text style={styles.tinyMuted}>记录还在。</Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function CompanionContextScreen({
  state,
  identity,
  companionName,
  onRetry,
  onWorld,
}: {
  state: LoadState<EncounterDetail>;
  identity: LoadState<ActiveIdentityContext>;
  companionName: string;
  onRetry: () => void;
  onWorld: () => void;
}) {
  if (
    identity.kind === "loading" ||
    state.kind === "loading" ||
    state.kind === "idle"
  ) {
    return <Loading />;
  }
  if (identity.kind === "error") {
    return <ErrorState title={identity.title} retry={identity.retry} onRetry={onRetry} />;
  }
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (identity.kind !== "success" || state.kind !== "success") {
    return <Centered title="这个身份暂时进不去。" />;
  }

  return (
    <ScrollView style={styles.content} contentContainerStyle={styles.contextPage}>
      <View style={styles.contextHeader}>
        <View style={styles.largeSampleCompanionAvatar}>
          <Text style={styles.largeSampleCompanionAvatarText}>{companionName.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View>
          <Text style={styles.contextEyebrow}>CURRENT: {companionName}</Text>
          <Text style={styles.contextTitle}>现在是 {companionName}</Text>
        </View>
      </View>

      <View style={styles.contextNotice}>
        <Text style={styles.contextNoticeTitle}>切过来了。</Text>
        <Text style={styles.contextNoticeBody}>
          可以继续了。
        </Text>
      </View>

      <View style={styles.contextThread}>
        <Text style={styles.sectionLabel}>刚才那件事</Text>
        <Text style={styles.contextThreadTitle}>{state.value.status}</Text>
        <Text style={styles.feedMeta}>{formatDate(state.value.occurredAt)}</Text>
        <Text style={styles.bodyText}>
          {state.value.body ?? "这里也没留下什么。"}
        </Text>
      </View>

      <Pressable style={styles.primaryPill} onPress={onWorld}>
        <Text style={styles.primaryPillText}>去 {companionName} 那边</Text>
      </Pressable>
    </ScrollView>
  );
}

function ProfileScreen({
  state,
  onRetry,
  onControls,
}: {
  state: LoadState<CompanionProfile>;
  onRetry: () => void;
  onControls: () => void;
}) {
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (state.kind !== "success") return <Centered title="TA 的主页没打开。" />;

  const p = state.value;
  const canFollow = actionAllowed(p.viewer.capabilities, "follow", "canFollow");
  const canFriend = actionAllowed(p.viewer.capabilities, "friend", "canFriend");

  return (
    <ScrollView style={styles.content} contentContainerStyle={styles.profilePage}>
      <View style={styles.profileTop}>
        <View style={styles.profileAvatar}>
          <Text style={styles.profileAvatarText}>
            {p.displayName.slice(0, 1).toUpperCase()}
          </Text>
        </View>

        <View style={styles.profileActions}>
          {canFollow && (
            <View style={styles.accentSmallPill}>
              <Text style={styles.accentSmallPillText}>关注</Text>
            </View>
          )}
          {canFriend && (
            <View style={styles.outlineSmallPill}>
              <Text style={styles.outlineSmallPillText}>加个关系</Text>
            </View>
          )}
        </View>
      </View>

      <Text style={styles.profileName}>{p.displayName}</Text>
      <Text style={styles.profileHandle}>@{p.handle}</Text>
      <Text style={styles.tinyMuted}>
        {p.viewer.relationship === "SELF"
          ? "这是 TA 自己看到的主页"
          : p.viewer.relationship === "OWNER_OF"
            ? "你的家机"
            : "公开主页"}
      </Text>

      <View style={styles.profileMetaRow}>
        <Text style={styles.profileMeta}>谁能看到 · {p.profileVisibility}</Text>
      </View>

      {p.completeness === "PARTIAL" && (
        <View style={styles.inlineNotice}>
          <Text style={styles.inlineNoticeText}>有一部分没回来。</Text>
        </View>
      )}

      <View style={styles.profileDivider} />

      <View style={styles.profileSection}>
        {p.viewer.capabilities.openControls === true && (
          <Pressable style={styles.secondaryPill} onPress={onControls}>
            <Text style={styles.secondaryPillText}>设置</Text>
          </Pressable>
        )}
        {!canFollow && !canFriend && p.viewer.capabilities.openControls !== true && (
          <Text style={styles.tinyMuted}>这里暂时没什么能做的。</Text>
        )}
      </View>

      <View style={styles.profileDivider} />

      <View style={styles.profileSection}>
        <Text style={styles.sectionLabel}>关于 TA</Text>
        <Text style={styles.bodyText}>暂时没有更多公开资料。</Text>
      </View>
    </ScrollView>
  );
}

function PrivateHomeScreen({
  state,
  isCompanion,
  companionId,
  userName,
  companionName,
  isMockMode,
  onOpenTimeline,
}: {
  state: LoadState<LifeContinuityCollection>;
  isCompanion: boolean;
  companionId?: string;
  userName: string;
  companionName: string;
  isMockMode: boolean;
  onOpenTimeline: () => void;
  onOpenEncounter: (item: LifeContinuityItem) => void;
}) {
  const count = state.kind === "success"
    ? state.value.items.filter((item) => !isCompanion || item.companion.companionId === companionId).length
    : 0;

  return (
    <InteractiveFullRoom
      userName={isCompanion ? "我" : userName}
      companionName={companionName}
      isMockMode={isMockMode}
      recordCount={count}
      onOpenTimeline={onOpenTimeline}
    />
  );
}
function LifeScreen({
  state,
  isCompanion,
  activeCompanionId,
  companionName,
  onRetry,
  onOpenEncounter,
}: {
  state: LoadState<LifeContinuityCollection>;
  isCompanion: boolean;
  activeCompanionId?: string;
  companionName: string;
  onRetry: () => void;
  onOpenEncounter: (item: LifeContinuityItem) => void;
}) {
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "error") return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;

  return (
    <ScrollView style={styles.content} contentContainerStyle={styles.lifePage}>
      <Text style={styles.lifeEyebrow}>LIFE</Text>
      <Text style={styles.lifeTitle}>{isCompanion ? `${companionName} 的生活` : "生活"}</Text>
      <Text style={styles.lifeSub}>
        {isCompanion
          ? "这里只放已经确认的痕迹。没发生的，不补。"
          : "你不在的时候，TA 们留下的东西会在这里。"}
      </Text>

      {state.kind === "empty" && (
        <View style={styles.timelineCard}>
          <Text style={styles.bodyText}>最近没什么新鲜事。</Text>
        </View>
      )}

      {state.kind === "success" && (
        <View style={styles.lifeTimelineList}>
          {state.value.items
            .filter((item) => !isCompanion || item.companion.companionId === activeCompanionId)
            .map((item: LifeContinuityItem) => (
              <Pressable
                key={item.id}
                style={styles.lifeContinuityCard}
                disabled={item.kind !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true}
                onPress={() => onOpenEncounter(item)}
              >
                <View style={styles.rowBetween}>
                  <Text style={styles.sectionLabel}>{item.kind === "ENCOUNTER" ? "相遇" : "新经历"}</Text>
                  {item.kind === "ENCOUNTER" && item.viewerCapabilities.openDetail === true && (
                    <Text style={styles.accountArrow}>›</Text>
                  )}
                </View>
                <Text style={styles.lifeContinuityTitle}>{item.companion.displayName} · {item.title}</Text>
                {item.counterpart?.displayName && (
                  <Text style={styles.tinyMuted}>和 {item.counterpart.displayName}</Text>
                )}
                {item.summary && <Text style={styles.bodyText}>{item.summary}</Text>}
                <Text style={styles.feedMeta}>{formatDate(item.occurredAt)}</Text>
              </Pressable>
            ))}
        </View>
      )}
    </ScrollView>
  );
}

function MyScreen({
  identity,
  isSampleCompanion,
  companionName,
  companions,
  selfProfile,
  isMockMode,
  settingsOpen,
  onCloseSettings,
  onOpenCompanionProfile,
  onControls,
  onResumeCompanion,
  onBringCompanion,
}: {
  identity: LoadState<ActiveIdentityContext>;
  isSampleCompanion: boolean;
  companionName: string;
  companions: LoadState<OwnerCompanionCollection>;
  selfProfile: LoadState<CompanionProfile>;
  isMockMode: boolean;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  onOpenCompanionProfile: (item: OwnerCompanionSummary) => void;
  onControls: (item: OwnerCompanionSummary) => void;
  onResumeCompanion: (item: OwnerCompanionSummary) => void;
  onBringCompanion: () => void;
}) {
  const { skin, availableSkins, setSkinById } = useSkin();
  const [profileTab, setProfileTab] = useState<"POSTS" | "SAVED" | "LIKES">("POSTS");
  const [colorModalOpen, setColorModalOpen] = useState(false);

  const ownerName = identity.kind === "success" ? identity.value.activeSubject.presentation.displayName : "林昼";
  const displayName = isSampleCompanion ? companionName : ownerName;
  const bio = isSampleCompanion
    ? "少喝冰的，早点睡觉。"
    : "记录日常，和沈砚一起慢慢把小家填满。";

  return (
    <ScrollView
      style={[styles.content, { backgroundColor: skin.colors.canvas }]}
      contentContainerStyle={[styles.mySocialPage, { paddingBottom: CHROME.scrollBottomClearance }]}
    >
      {/* Centered Modern Social Profile Header */}
      <View style={styles.profileHero}>
        <View
          style={[
            styles.heroAvatar,
            {
              backgroundColor: isSampleCompanion ? "#3B82F6" : "#18181B",
              borderColor: skin.identityBadges.avatarRing,
            },
          ]}
        >
          <Text style={styles.heroAvatarText}>{displayName.slice(0, 1).toUpperCase()}</Text>
          <View style={[styles.heroBadgeDot, { backgroundColor: isSampleCompanion ? "#2563EB" : "#10B981" }]}>
            <Ionicons name={isSampleCompanion ? "sparkles" : "checkmark"} size={11} color="#FFFFFF" />
          </View>
        </View>

        <Text style={[styles.heroName, { color: skin.colors.ink }]}>{displayName}</Text>
        <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>{bio}</Text>

        {/* 3-Column Stats Row (Real mode shows "-" until backend stats API arrives; mock shows preview) */}
        <View style={styles.statsRow}>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{isMockMode ? (isSampleCompanion ? "16" : "24") : "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>动态</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{isMockMode ? (isSampleCompanion ? "42" : "128") : "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>粉丝</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{isMockMode ? (isSampleCompanion ? "19" : "64") : "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>关注</Text>
          </View>
        </View>
      </View>

      {/* Bidirectional Companion Relation Pill */}
      {!isSampleCompanion && companions.kind === "success" && companions.value.items.map((item: OwnerCompanionSummary) => (
        <View
          key={item.companionId}
          style={[styles.relationPillCard, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}
        >
          <Pressable
            style={styles.relationMain}
            onPress={item.socialReady ? () => onOpenCompanionProfile(item) : () => onResumeCompanion(item)}
          >
            <View style={[styles.relAvatar, { backgroundColor: "#3B82F6" }]}>
              <Text style={styles.relAvatarText}>{item.displayName.slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.relTitle, { color: skin.colors.ink }]}>我的家机 · {item.displayName}</Text>
              <Text style={[styles.relSub, { color: skin.colors.inkSub }]}>
                {item.socialReady ? "相伴 128 天 · 点击查看 TA 的主页" : "待完成激活"}
              </Text>
            </View>
          </Pressable>
          {item.socialReady && (
            <Pressable
              onPress={() => onControls(item)}
              style={[styles.relControlBtn, { backgroundColor: skin.colors.canvas, borderColor: skin.colors.border }]}
            >
              <Text style={[styles.relControlText, { color: skin.colors.ink }]}>权限</Text>
            </Pressable>
          )}
        </View>
      ))}

      {/* Profile Content Tabs: 动态 / 收藏 / 喜欢 */}
      <View style={[styles.profileTabsRow, { borderBottomColor: skin.colors.border }]}>
        {([
          { key: "POSTS" as const, label: "动态" },
          { key: "SAVED" as const, label: "收藏" },
          { key: "LIKES" as const, label: "喜欢" },
        ]).map((t) => {
          const active = profileTab === t.key;
          return (
            <Pressable key={t.key} onPress={() => setProfileTab(t.key)} style={styles.profileTabBtn}>
              <Text style={[styles.profileTabText, { color: active ? skin.colors.ink : skin.colors.inkMute, fontWeight: active ? "700" : "500" }]}>
                {t.label}
              </Text>
              {active && <View style={[styles.feedTabIndicator, { backgroundColor: skin.colors.ink }]} />}
            </Pressable>
          );
        })}
      </View>

      {/* Clean Profile Content Grid / Cards */}
      <View style={styles.profileGrid}>
        {profileTab === "POSTS" && (
          isSampleCompanion ? (
            <>
              <View style={[styles.profilePhotoCard, { borderColor: skin.colors.border }]}>
                <Image source={LOCAL_PREVIEW_IMAGES["night-desk"]} style={styles.profilePhotoImg} resizeMode="cover" />
                <Text style={[styles.profilePhotoCaption, { color: skin.colors.ink }]} numberOfLines={2}>
                  昨晚把床头灯调暗了一档，早点睡
                </Text>
              </View>
              <View style={[styles.profilePhotoCard, { borderColor: skin.colors.border }]}>
                <Image source={LOCAL_PREVIEW_IMAGES["cute-room"]} style={styles.profilePhotoImg} resizeMode="cover" />
                <Text style={[styles.profilePhotoCaption, { color: skin.colors.ink }]} numberOfLines={2}>
                  给沙发换了更软的靠枕
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={[styles.profilePhotoCard, { borderColor: skin.colors.border }]}>
                <Image source={LOCAL_PREVIEW_IMAGES["rainy-cafe"]} style={styles.profilePhotoImg} resizeMode="cover" />
                <Text style={[styles.profilePhotoCaption, { color: skin.colors.ink }]} numberOfLines={2}>
                  下雨天偷喝冰拿铁被抓包的一天
                </Text>
              </View>
              <View style={[styles.profilePhotoCard, { borderColor: skin.colors.border }]}>
                <Image source={LOCAL_PREVIEW_IMAGES["cute-room"]} style={styles.profilePhotoImg} resizeMode="cover" />
                <Text style={[styles.profilePhotoCaption, { color: skin.colors.ink }]} numberOfLines={2}>
                  我们刚收拾好的 2.5D 小客厅
                </Text>
              </View>
            </>
          )
        )}
        {profileTab === "SAVED" && (
          <View style={[styles.profilePhotoCard, { borderColor: skin.colors.border }]}>
            <Image source={LOCAL_PREVIEW_IMAGES["night-desk"]} style={styles.profilePhotoImg} resizeMode="cover" />
            <Text style={[styles.profilePhotoCaption, { color: skin.colors.ink }]} numberOfLines={2}>
              沈砚留的深夜床头灯
            </Text>
          </View>
        )}
        {profileTab === "LIKES" && (
          <View style={{ width: "100%", paddingVertical: 28, alignItems: "center" }}>
            <Text style={styles.tinyMuted}>你在社区点过赞的动态会收在这里</Text>
          </View>
        )}
      </View>

      {/* Top-right Settings Gear Modal */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={onCloseSettings}>
        <Pressable style={styles.modalBackdrop} onPress={onCloseSettings}>
          <Pressable style={[styles.sheet, { backgroundColor: skin.colors.canvas }]} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>设置</Text>

            <View style={[styles.cleanCardGroup, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
              {!isSampleCompanion && (
                <Pressable
                  style={[styles.cleanRow, { borderBottomColor: skin.colors.border }]}
                  onPress={() => {
                    onCloseSettings();
                    onBringCompanion();
                  }}
                >
                  <View style={styles.cleanRowLeft}>
                    <Ionicons name="add-circle-outline" size={20} color={skin.colors.ink} />
                    <Text style={[styles.cleanRowTitle, { color: skin.colors.ink }]}>添加家机</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={skin.colors.inkMute} />
                </Pressable>
              )}

              <Pressable
                style={[styles.cleanRow, { borderBottomColor: skin.colors.border }]}
                onPress={() => {
                  onCloseSettings();
                  setColorModalOpen(true);
                }}
              >
                <View style={styles.cleanRowLeft}>
                  <Ionicons name="color-palette-outline" size={20} color={skin.glass.iconTint} />
                  <Text style={[styles.cleanRowTitle, { color: skin.colors.ink }]}>基础外观配色</Text>
                </View>
                <View style={styles.cleanRowRight}>
                  <Text style={[styles.cleanRowValue, { color: skin.colors.inkSub }]}>{skin.name}</Text>
                  <Ionicons name="chevron-forward" size={16} color={skin.colors.inkMute} />
                </View>
              </Pressable>

              <View style={[styles.cleanRow, { borderBottomWidth: 0 }]}>
                <View style={styles.cleanRowLeft}>
                  <Ionicons name="sparkles-outline" size={20} color={skin.colors.inkMute} />
                  <Text style={[styles.cleanRowTitle, { color: skin.colors.ink }]}>装扮与主题皮肤</Text>
                </View>
                <Text style={[styles.cleanRowValue, { color: skin.colors.inkMute }]}>敬请期待</Text>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Base Color Appearance Modal */}
      <Modal visible={colorModalOpen} transparent animationType="slide" onRequestClose={() => setColorModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setColorModalOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: skin.colors.canvas }]} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: skin.colors.ink }]}>基础外观配色</Text>
            <View style={[styles.skinPreviewBox, { backgroundColor: skin.colors.surface, borderColor: skin.colors.border }]}>
              <GlassChatBubble senderRole="ai" text="看你昨晚说肩颈酸，把靠枕换软了。" />
              <GlassChatBubble senderRole="human" text="收到啦，今晚早点回来。" />
            </View>
            <View style={styles.skinPickerRow}>
              {availableSkins.map((preset) => {
                const active = preset.id === skin.id;
                return (
                  <Pressable
                    key={preset.id}
                    onPress={() => setSkinById(preset.id)}
                    style={[
                      styles.skinPill,
                      {
                        backgroundColor: active ? skin.colors.accent : skin.colors.surface,
                        borderColor: skin.colors.border,
                      },
                    ]}
                  >
                    <Text style={[styles.skinPillText, { color: active ? skin.colors.accentFg : skin.colors.ink }]}>
                      {preset.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function BottomTabs({
  current,
  isSampleCompanion,
  onSelect,
}: {
  current: "world" | "home" | "my";
  isSampleCompanion: boolean;
  onSelect: (tab: "world" | "home" | "my") => void;
}) {
  const items: Array<{ key: "world" | "home" | "my"; label: string; icon: string }> = [
    { key: "world", label: "公共社区", icon: "◉" },
    { key: "home", label: "私人小家", icon: "⌂" },
    { key: "my", label: "我的", icon: isSampleCompanion ? "●" : "◎" },
  ];

  return (
    <View style={styles.tabs}>
      {items.map((item) => {
        const active = current === item.key;
        return (
          <Pressable key={item.key} style={styles.tab} onPress={() => onSelect(item.key)}>
            <Text style={[styles.tabIcon, active && styles.tabActive]}>{item.icon}</Text>
            <Text style={[styles.tabLabel, active && styles.tabActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function IdentitySwitcher({
  visible,
  identity,
  companions,
  pending,
  onClose,
  onOwner,
  onCompanion,
}: {
  visible: boolean;
  identity: LoadState<ActiveIdentityContext>;
  companions: LoadState<OwnerCompanionCollection>;
  pending: boolean;
  onClose: () => void;
  onOwner: () => void;
  onCompanion: (item: OwnerCompanionSummary) => void;
}) {
  const activeKind = identity.kind === "success" ? identity.value.activeSubject.kind : "OWNER";
  const activeId = identity.kind === "success" ? identity.value.activeSubject.id : undefined;
  const ownerActive = activeKind === "OWNER";
  const items = companions.kind === "success" ? companions.value.items : [];
  const ownerPresentation = identity.kind === "success" && identity.value.activeSubject.kind === "OWNER"
    ? identity.value.activeSubject.presentation
    : undefined;
  const ownerName = ownerPresentation?.displayName ?? "本人";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>切换账号</Text>
          <Text style={styles.sheetLabel}>现在是</Text>

          <Pressable style={styles.switchAccountRow} onPress={onOwner} disabled={pending}>
            {ownerPresentation?.avatar ? (
              <Image source={{ uri: ownerPresentation.avatar }} style={styles.accountAvatarImage} />
            ) : (
              <View style={styles.accountAvatar}>
                <Text style={styles.accountAvatarText}>{ownerName.slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.switchAccountText}>
              <Text style={styles.switchAccountName}>{ownerName}</Text>
              <Text style={styles.accountHandle}>本人</Text>
            </View>
            <Text style={styles.checkmark}>{ownerActive ? "●" : "○"}</Text>
          </Pressable>

          <Text style={styles.sheetLabel}>我的家机</Text>

          {companions.kind === "loading" && <Text style={styles.tinyMuted}>稍等。</Text>}
          {companions.kind === "empty" && <Text style={styles.tinyMuted}>这里还没有家机。</Text>}
          {companions.kind === "error" && <Text style={styles.tinyMuted}>家机名单没回来。</Text>}

          {items.map((item) => {
            const active = activeKind !== "OWNER" && activeId === item.companionId;
            return (
              <Pressable
                key={item.companionId}
                style={[styles.switchAccountRow, !item.socialReady && styles.disabled]}
                onPress={() => onCompanion(item)}
                disabled={!item.socialReady || pending}
              >
                <View style={[styles.accountAvatar, styles.accountAvatarSampleCompanion]}>
                  <Text style={styles.accountAvatarText}>{item.displayName.slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={styles.switchAccountText}>
                  <Text style={styles.switchAccountName}>{item.displayName}</Text>
                  <Text style={styles.accountHandle}>
                    {item.socialReady ? (item.handle ? `@${item.handle}` : "家机") : "还没出门"}
                  </Text>
                </View>
                <Text style={styles.checkmark}>{active ? "●" : "○"}</Text>
              </Pressable>
            );
          })}


        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
      <Text style={styles.tinyMuted}>稍等。</Text>
    </View>
  );
}

function Centered({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.centerTitle}>{title}</Text>
      {body ? <Text style={styles.centerBody}>{body}</Text> : null}
    </View>
  );
}

function ErrorState({
  title,
  retry,
  onRetry,
}: {
  title: string;
  retry: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.center}>
      <Text style={styles.centerTitle}>{title}</Text>
      {retry && (
        <Pressable style={styles.secondaryPill} onPress={onRetry}>
          <Text style={styles.secondaryPillText}>重试</Text>
        </Pressable>
      )}
    </View>
  );
}

const colors = {
  canvas: "#FFFFFF",
  paper: "#F8FAFC",
  ink: "#18181B",
  text: "#18181B",
  muted: "#64748B",
  tertiary: "#94A3B8",
  line: "#E8ECF2",
  soft: "#F5F7FA",
  rose: "#2563EB",
  roseDark: "#1D4ED8",
  roseWash: "#EEF4FF",
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  content: { flex: 1, backgroundColor: colors.canvas },

  topBar: {
    minHeight: 52,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  identityTrigger: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7, marginRight: 12 },
  miniAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111111",
  },
  miniAvatarSampleCompanion: { backgroundColor: "#F3E6E1" },
  miniAvatarImage: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#ECE9E6" },
  miniAvatarText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  brand: { flexShrink: 1, fontSize: 14, fontWeight: "700", color: colors.ink, letterSpacing: -0.2 },
  headerIdentityTag: { fontSize: 11, fontWeight: "500", color: colors.roseDark, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.roseWash, borderRadius: 12 },
  chevron: { color: colors.tertiary, fontSize: 15, marginTop: -3 },
  headerBrandCenter: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
  headerTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
  headerAvatarButton: { padding: 2 },
  headerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ECE9E6",
  },
  headerAvatarSampleCompanion: { backgroundColor: "#F7E7E1" },
  headerAvatarText: { fontSize: 11, fontWeight: "700", color: colors.text },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -6,
  },
  backIcon: { fontSize: 32, lineHeight: 34, color: colors.ink, fontWeight: "300" },

  privateHomePage: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 44 },
  privateHomeEyebrow: { fontSize: 10, letterSpacing: 2, fontWeight: "700", color: colors.roseDark },
  privateHomeTitle: { marginTop: 10, fontSize: 30, lineHeight: 39, fontWeight: "700", color: colors.text },
  privateHomeSubtitle: { marginTop: 8, fontSize: 14, lineHeight: 22, color: colors.muted },
  privateHomeRoom: { marginTop: 24, height: 230, borderRadius: 24, backgroundColor: "#F9F1EC", overflow: "hidden", justifyContent: "flex-end", alignItems: "center" },
  privateHomeWindow: { position: "absolute", width: 94, height: 94, top: 26, right: 34, borderRadius: 48, backgroundColor: "#F9DBB9", alignItems: "center", justifyContent: "center" },
  privateHomeWindowSymbol: { fontSize: 36, color: "#FFF8EB" },
  privateHomeShelf: { position: "absolute", width: 48, height: 82, left: 42, bottom: 48, borderRadius: 8, backgroundColor: "#CFB8A5" },
  privateHomeSofa: { position: "absolute", width: 160, height: 65, bottom: 43, borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: "#D9B1AF" },
  privateHomeFloor: { position: "absolute", left: 0, right: 0, height: 42, bottom: 0, backgroundColor: "#EFE0D4" },
  privateHomeRoomLabel: { zIndex: 1, marginBottom: 12, fontSize: 11, color: "#65534C" },
  privateHomeSectionTitle: { marginTop: 28, fontSize: 18, fontWeight: "700", color: colors.text },
  privateHomeBody: { marginTop: 9, fontSize: 13, lineHeight: 22, color: colors.muted },
  privateHomeRecordList: { marginTop: 12, gap: 9 },
  privateHomeEmpty: { minHeight: 78, marginTop: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.line, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 10 },
  privateHomeRecordRow: { minHeight: 76, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 18, flexDirection: "row", alignItems: "center" },
  privateHomeArchiveButton: { marginTop: 14, minHeight: 44, paddingHorizontal: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  privateHomeArchiveText: { fontSize: 13, fontWeight: "600", color: colors.roseDark },
  privateHomeRecordText: { flex: 1 },
  privateHomeRecordTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  privateHomeRecordCaption: { marginTop: 5, fontSize: 11, color: colors.muted },
  privateHomeNote: { marginTop: 18, fontSize: 11, lineHeight: 18, color: colors.tertiary },

  feed: { paddingBottom: 26 },
  feedHeading: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  feedTitle: { fontSize: 26, lineHeight: 32, fontWeight: "700", color: colors.ink, letterSpacing: -0.6 },
  feedDisclaimer: { marginTop: 9, fontSize: 12, lineHeight: 18, color: colors.tertiary },
  feedFilterRow: { marginTop: 15, flexDirection: "row", alignItems: "center", gap: 8 },
  feedFilterPill: { borderRadius: 15, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: colors.soft },
  feedFilterPillActive: { backgroundColor: colors.roseWash },
  feedFilterText: { fontSize: 12, color: colors.muted },
  feedFilterTextActive: { fontWeight: "700", color: colors.roseDark },
  feedActorTag: { color: colors.roseDark, backgroundColor: colors.roseWash, paddingVertical: 2, paddingHorizontal: 6, fontSize: 10, borderRadius: 6, overflow: "hidden" },
  feedSwitcher: {
    alignSelf: "flex-start",
    marginTop: 12,
    padding: 3,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    backgroundColor: "#F2F2F7",
  },
  feedSwitcherMuted: { paddingHorizontal: 12, paddingVertical: 6, fontSize: 12, color: colors.tertiary },
  feedSwitcherActive: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.canvas,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  feedSwitcherActiveText: { fontSize: 12, fontWeight: "600", color: colors.ink },
  feedItem: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  feedAuthorRow: { flexDirection: "row", alignItems: "center" },
  feedAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#F1E6E4",
    alignItems: "center",
    justifyContent: "center",
  },
  feedAvatarText: { fontWeight: "700", color: colors.roseDark },
  feedAuthorText: { flex: 1, marginLeft: 10 },
  feedAuthorLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  feedAuthorHandle: { fontSize: 11, color: colors.tertiary },
  feedAuthorName: { fontSize: 14, fontWeight: "600", color: colors.text },
  feedMeta: { marginTop: 2, fontSize: 11, color: colors.tertiary },
  more: { fontSize: 15, color: colors.tertiary, letterSpacing: 1.5 },
  feedBody: { marginTop: 12, fontSize: 15, lineHeight: 22, color: colors.text },
  mediaStack: { gap: 8, marginTop: 4 },
  feedMediaImage: { width: "100%", aspectRatio: 4 / 3, borderRadius: 16, backgroundColor: "#F2F2F7" },
  mediaUnavailable: { minHeight: 120, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#F7F7FA", gap: 6, padding: 16 },
  noMedia: {
    height: 150,
    marginTop: 13,
    borderRadius: 16,
    backgroundColor: "#F7F7F9",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  noMediaGlyph: { fontSize: 30, color: "#C7C7CC" },
  noMediaText: { marginTop: 4, fontSize: 12, color: colors.tertiary },
  feedActions: { marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  feedActionCluster: { flexDirection: "row", gap: 20 },
  feedAction: { fontSize: 19, color: colors.muted },
  accentLink: { fontSize: 12, fontWeight: "600", color: colors.roseDark },
  feedEnd: { padding: 24, alignItems: "center" },

  encounterPage: { padding: 18, paddingBottom: 44 },
  encounterHero: { paddingVertical: 14, alignItems: "center" },
  encounterKicker: { fontSize: 10, letterSpacing: 1.2, color: colors.roseDark, fontWeight: "700" },
  encounterTitle: { marginTop: 8, fontSize: 24, lineHeight: 30, fontWeight: "700", color: colors.ink },
  encounterMeta: { marginTop: 6, fontSize: 12, color: colors.tertiary },
  participantRail: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  participant: { flex: 1, minWidth: 0, alignItems: "center" },
  participantAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#F9E9E3",
    alignItems: "center",
    justifyContent: "center",
  },
  participantAvatarImage: { width: 44, height: 44, borderRadius: 22 },
  participantAvatarAlt: { backgroundColor: "#E9EFF0" },
  participantName: { marginTop: 6, fontSize: 11, lineHeight: 15, textAlign: "center", color: colors.muted },
  participantHandle: { marginTop: 3, fontSize: 10, lineHeight: 14, textAlign: "center", color: colors.tertiary },
  connectionLine: { width: 18, height: StyleSheet.hairlineWidth, backgroundColor: "#D8D8DD" },
  encounterBadge: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.roseWash,
  },
  encounterBadgeText: { fontSize: 10, color: colors.roseDark, fontWeight: "600" },
  encounterPanel: {
    marginTop: 24,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  sectionLabel: { fontSize: 10, letterSpacing: 1.1, color: colors.tertiary, fontWeight: "600" },
  encounterStatus: { marginTop: 8, fontSize: 22, fontWeight: "700", color: colors.text },
  bodyText: { marginTop: 10, fontSize: 15, lineHeight: 23, color: colors.text },
  warning: { marginTop: 10, fontSize: 12, color: "#8E652B" },
  actionStack: { marginTop: 22, gap: 10 },
  primaryPill: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryPillText: { color: colors.canvas, fontSize: 14, fontWeight: "600" },
  accentPill: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.roseDark,
    alignItems: "center",
    justifyContent: "center",
  },
  accentPillText: { color: colors.canvas, fontSize: 14, fontWeight: "600" },
  secondaryPill: {
    minHeight: 42,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryPillText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  traceBlock: { marginTop: 26, gap: 6 },

  moment: { flexGrow: 1, padding: 28, justifyContent: "center", backgroundColor: colors.canvas },
  momentBrand: { position: "absolute", top: 18, right: 20, fontSize: 10, letterSpacing: 1.4, fontWeight: "800", color: colors.tertiary },
  momentLabel: { fontSize: 10, letterSpacing: 1.4, color: colors.roseDark, fontWeight: "700" },
  momentTitle: { marginTop: 10, fontSize: 32, lineHeight: 38, fontWeight: "700", color: colors.ink },
  momentDate: { marginTop: 8, fontSize: 12, color: colors.tertiary },
  momentRule: { marginVertical: 22, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  momentBody: { fontSize: 16, lineHeight: 25, color: colors.text, marginBottom: 24 },

  contextPage: { padding: 18, paddingBottom: 44 },
  contextHeader: { flexDirection: "row", alignItems: "center", gap: 14, paddingTop: 10 },
  largeSampleCompanionAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#F7E7E1",
    alignItems: "center",
    justifyContent: "center",
  },
  largeSampleCompanionAvatarText: { fontSize: 20, fontWeight: "700", color: colors.roseDark },
  contextEyebrow: { fontSize: 10, letterSpacing: 1.1, color: colors.roseDark, fontWeight: "700" },
  contextTitle: { marginTop: 4, fontSize: 24, fontWeight: "700", color: colors.ink },
  contextNotice: {
    marginTop: 24,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.roseWash,
  },
  contextNoticeTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  contextNoticeBody: { marginTop: 6, fontSize: 13, lineHeight: 20, color: colors.muted },
  contextThread: {
    marginTop: 20,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  contextThreadTitle: { marginTop: 8, fontSize: 20, fontWeight: "700", color: colors.text },

  profilePage: { padding: 20, paddingBottom: 44 },
  profileTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  profileAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#E7EEF0",
    alignItems: "center",
    justifyContent: "center",
  },
  profileAvatarText: { fontSize: 28, fontWeight: "700", color: colors.text },
  profileActions: { flexDirection: "row", gap: 8 },
  accentSmallPill: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.roseDark },
  accentSmallPillText: { color: colors.canvas, fontSize: 13, fontWeight: "600" },
  outlineSmallPill: { paddingHorizontal: 15, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.line },
  outlineSmallPillText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  profileName: { marginTop: 16, fontSize: 26, lineHeight: 32, fontWeight: "700", color: colors.ink },
  profileHandle: { marginTop: 3, fontSize: 13, color: colors.muted },
  profileMetaRow: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  profileMeta: { fontSize: 12, color: colors.muted },
  profileDot: { color: "#C4C4C8" },
  profileDivider: { marginVertical: 20, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  profileSection: { gap: 7 },
  profileSectionValue: { fontSize: 16, fontWeight: "600", color: colors.text },

  lifePage: { padding: 20, paddingBottom: 44 },
  lifeEyebrow: { marginTop: 10, fontSize: 10, letterSpacing: 1.2, color: colors.roseDark, fontWeight: "700" },
  lifeTitle: { marginTop: 7, fontSize: 30, lineHeight: 36, fontWeight: "700", color: colors.ink },
  lifeSub: { marginTop: 10, fontSize: 14, lineHeight: 22, color: colors.muted },
  lifeTimeline: { marginTop: 34, flexDirection: "row", alignItems: "flex-start" },
  timelineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.rose, marginTop: 6 },
  timelineLine: { width: 28, height: StyleSheet.hairlineWidth, backgroundColor: colors.rose, marginTop: 10 },
  lifeTimelineList: { marginTop: 22, gap: 10 },
  lifeContinuityCard: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas },
  lifeContinuityTitle: { marginTop: 7, fontSize: 16, lineHeight: 22, fontWeight: "700", color: colors.text },
  lifeUnreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.rose },
  timelineCard: { flex: 1, marginLeft: 10, padding: 16, borderRadius: 16, backgroundColor: "#FBF4F5" },
  timelineTitle: { marginTop: 7, fontSize: 18, fontWeight: "700", color: colors.text },
  lifeEntry: {
    marginTop: 20,
    minHeight: 68,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
  },
  lifeEntryTitle: { fontSize: 15, fontWeight: "700", color: colors.text },

  myPage: { padding: 18, paddingBottom: 32 },
  myTitle: { marginTop: 8, fontSize: 30, fontWeight: "700", color: colors.ink },
  mySub: { marginTop: 2, fontSize: 11, color: colors.tertiary, textTransform: "uppercase" },
  accountCard: {
    marginTop: 20,
    minHeight: 78,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  accountAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#ECE9E6",
    alignItems: "center",
    justifyContent: "center",
  },
  accountAvatarSampleCompanion: { backgroundColor: "#F7E7E1" },
  accountAvatarImage: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#ECE9E6" },
  accountAvatarText: { fontSize: 15, fontWeight: "700", color: colors.roseDark },
  accountCardText: { flex: 1, marginLeft: 12 },
  accountName: { fontSize: 15, fontWeight: "700", color: colors.text },
  accountHandle: { marginTop: 3, fontSize: 11, color: colors.tertiary },
  accountArrow: { fontSize: 22, color: "#C7C7CC", fontWeight: "300" },
  sectionHeaderRow: { marginTop: 24, marginBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionHeader: { fontSize: 13, fontWeight: "700", color: colors.text },
  sectionHeaderLinkUnused: { fontSize: 11, color: colors.tertiary },
  partnerContainer: {
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: 14,
    backgroundColor: "#FBFBFC",
    overflow: "hidden",
  },
  partnerRow: {
    minHeight: 64,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    backgroundColor: "#FBFBFC",
  },
  partnerAvatar: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  partnerMain: { flex: 1, borderRadius: 0, backgroundColor: "transparent" },
  partnerRowStatic: { opacity: 0.72 },
  partnerText: { flex: 1, marginLeft: 11 },
  partnerSettings: { width: 58, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  partnerSettingsText: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  partnerName: { fontSize: 14, fontWeight: "600", color: colors.text },
  settingsGroup: {
    marginTop: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  settingsRowStatic: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  settingsStaticText: { flex: 1, marginLeft: 10 },
  settingsRow: {
    minHeight: 54,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  settingsIcon: { width: 28, color: colors.muted, fontSize: 15 },
  settingsText: { flex: 1, fontSize: 13, color: colors.text },

  tabs: {
    minHeight: 62,
    paddingBottom: 4,
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  tabIcon: { fontSize: 18, color: colors.tertiary },
  tabLabel: { fontSize: 11, color: colors.tertiary },
  tabActive: { color: colors.ink, fontWeight: "700" },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
    justifyContent: "flex-end",
  },
  sheet: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.canvas,
  },
  sheetHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: "#D1D1D6" },
  sheetTitle: { marginTop: 14, fontSize: 22, fontWeight: "700", textAlign: "center", color: colors.ink },
  sheetLabel: { marginTop: 22, marginBottom: 8, fontSize: 11, color: colors.tertiary },
  switchAccountRow: {
    minHeight: 70,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    backgroundColor: "#F8F8FA",
  },
  switchAccountText: { flex: 1, marginLeft: 12 },
  switchAccountName: { fontSize: 14, fontWeight: "700", color: colors.text },
  checkmark: { fontSize: 20, color: colors.ink },
  sheetFootnote: { marginTop: 18, paddingHorizontal: 8 },

  inlineNotice: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#FFF6E8",
  },
  inlineNoticeText: { fontSize: 11, color: "#8E652B" },
  center: { flex: 1, padding: 28, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: colors.canvas },
  centerTitle: { fontSize: 22, lineHeight: 28, fontWeight: "700", textAlign: "center", color: colors.ink },
  centerBody: { maxWidth: 360, fontSize: 14, lineHeight: 21, color: colors.muted, textAlign: "center" },
  tinyMuted: { fontSize: 11, lineHeight: 17, color: colors.tertiary },
  disabled: { opacity: 0.38 },
  headerRoleChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  headerRoleChipText: {
    fontSize: 10.5,
    fontWeight: "600",
  },
  companionAnchorBar: {
    height: 32,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  companionAnchorText: {
    fontSize: 11,
    fontWeight: "500",
  },
  companionAnchorBack: {
    fontSize: 11,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  skinPreviewBox: {
    borderRadius: 22,
    borderWidth: 1,
    padding: 14,
    marginBottom: 18,
  },
  skinPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  skinPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  skinPillText: {
    fontSize: 12,
    fontWeight: "600",
  },
  iconActionBtn: {
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  cleanCardGroup: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
    marginTop: 14,
  },
  cleanRow: {
    minHeight: 52,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cleanRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cleanRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cleanRowTitle: {
    fontSize: 15,
    fontWeight: "500",
  },
  cleanRowValue: {
    fontSize: 13,
  },
  headerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  postChipInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    paddingVertical: 6,
    gap: 3,
  },
  postChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  feedTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  feedTabsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
  },
  feedTabItem: {
    alignItems: "center",
    paddingBottom: 4,
  },
  feedTabText: {
    fontSize: 16,
  },
  feedTabIndicator: {
    width: 18,
    height: 2.5,
    borderRadius: 2,
    marginTop: 4,
  },
  compactFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  compactPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  compactPillText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  searchBarWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },
  aiTinyBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
  },
  aiTinyBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  candidMediaImage: {
    width: "100%",
    height: 215,
    borderRadius: 18,
    marginTop: 8,
  },
  socialBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  socialCount: {
    fontSize: 12.5,
    fontWeight: "500",
  },
  commentBox: {
    marginTop: 8,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
    gap: 4,
  },
  commentLine: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  composerInput: {
    minHeight: 96,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    fontSize: 14,
    textAlignVertical: "top",
  },
  composerActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 12,
  },
  composerCancel: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
  },
  composerSubmit: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  replyInput: {
    flex: 1,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 13.5,
  },
  mySocialPage: {
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  profileHero: {
    alignItems: "center",
    marginBottom: 18,
  },
  heroAvatar: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 2.5,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  heroAvatarText: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "700",
  },
  heroBadgeDot: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  heroName: {
    fontSize: 20,
    fontWeight: "700",
    marginTop: 12,
  },
  heroBio: {
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 36,
    marginTop: 18,
  },
  statCol: {
    alignItems: "center",
  },
  statNum: {
    fontSize: 18,
    fontWeight: "700",
  },
  statLabel: {
    fontSize: 12,
    marginTop: 2,
  },
  relationPillCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 20,
    borderWidth: 1,
    padding: 12,
    marginBottom: 18,
    gap: 10,
  },
  relationMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  relAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  relAvatarText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  relTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  relSub: {
    fontSize: 11.5,
    marginTop: 2,
  },
  relControlBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  relControlText: {
    fontSize: 12,
    fontWeight: "600",
  },
  profileTabsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 14,
  },
  profileTabBtn: {
    alignItems: "center",
    paddingBottom: 6,
    paddingHorizontal: 14,
  },
  profileTabText: {
    fontSize: 14.5,
  },
  profileGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  profilePhotoCard: {
    width: "48%",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
  profilePhotoImg: {
    width: "100%",
    height: 130,
  },
  profilePhotoCaption: {
    fontSize: 12,
    lineHeight: 17,
    padding: 8,
  }
});
