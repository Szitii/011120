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
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { createClientBootstrap, type ClientBootstrap } from "./src/adapters";
import { RealApiAdapter, safeClientMessage } from "./src/adapters/real-api";
import { AccountGate } from "./src/auth/AccountGate";
import type { AccountBinding } from "./src/auth/account-session";
import type { CommunityClient, CommunityPost, CommunityProfile } from "../../packages/community-contracts/types";
import { colors } from "./src/theme";
import { CommunityScreen } from "./src/community/CommunityScreen";
import { HumanProfileEditor } from "./src/community/HumanProfileEditor";
import Ionicons from "@expo/vector-icons/Ionicons";
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
import { BottomSheet } from "./src/components/BottomSheet";
import { GlassChatBubble } from "./src/components/GlassChatBubble";

type LoadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "success"; value: T }
  | { kind: "empty" }
  | { kind: "error"; title: string; retry: boolean };

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
    <SkinProvider>
      <AppShell />
    </SkinProvider>
  );
}

function AppShell() {
  const bootstrap = useMemo(() => {
    try {
      return { value: createClientBootstrap() } as const;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Client configuration error",
      } as const;
    }
  }, []);

  if ("error" in bootstrap) {
    return <Centered title="Client configuration required" body={bootstrap.error} />;
  }
  const config = bootstrap.value;
  if (config.dataMode !== "real") return <WorldApp client={config} isMockMode={config.dataMode === "mock"} />;

  return <AccountGate config={config}>
    {(account, onSignOut) => <SignedInWorld key={account.generation}
      baseUrl={config.baseUrl} account={account} onSignOut={onSignOut} />}
  </AccountGate>;
}

function SignedInWorld({ baseUrl, account, onSignOut }: {
  baseUrl: string;
  account: AccountBinding;
  onSignOut: () => void;
}) {
  const client = useMemo(() => ({ api: new RealApiAdapter({ baseUrl, session: account.tokens }) }), [baseUrl, account]);
  return <WorldApp client={client} isMockMode={false} account={{ email: account.email, signOut: onSignOut }} />;
}

function WorldApp({ client, account, isMockMode }: {
  client: ClientBootstrap;
  isMockMode: boolean;
  account?: { email?: string; signOut: () => void };
}) {
  const { skin } = useSkin();
  const [cache] = useState(() => new ViewerSensitiveCache());
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
  const [mySettingsOpen, setMySettingsOpen] = useState(false);
  const [companionDisplayName, setCompanionDisplayName] = useState("我的家机");
  const worldScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

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
    void loadIdentityOwner();
    return () => {
      cache.purgeViewerSensitive();
    };
  }, [client]);

  useEffect(() => {
    if (identity.kind !== "success") return;
    if (route.type === "root" && route.tab === "world") void loadWorld();
    if (route.type === "life-archive" || (route.type === "root" && route.tab === "home")) void loadLife();
    if (
      route.type === "root" &&
      route.tab === "my" &&
      identity.value.activeSubject.kind === "COMPANION"
    ) {
      void loadProfile(identity.value.activeSubject.id);
    }
    if (route.type === "encounter") void loadEncounter(route.encounterId);
    if (route.type === "profile") void loadProfile(route.companionId);
  }, [
    route.type,
    route.type === "root" ? route.tab : "",
    route.type === "encounter" ? route.encounterId : "",
    route.type === "profile" ? route.companionId : "",
    identity.kind === "success" ? identity.value.activeSubject.id : "",
  ]);

  async function loadIdentityOwner() {
    setIdentity({ kind: "loading" });
    try {
      const value = await client.api.identityContext();
      setIdentity({ kind: "success", value });
      void loadOwnerCompanions();
      if (client.sample_companionCompanionId) {
        try {
          const ownCompanion = await client.api.companionProfile(
            client.sample_companionCompanionId,
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
    setOwnerCompanions({ kind: "loading" });
    try {
      const value = await client.api.ownerCompanions();
      setOwnerCompanions(value.items.length ? { kind: "success", value } : { kind: "empty" });
    } catch (error) {
      const safe = safeClientMessage(error);
      setOwnerCompanions({ kind: "error", ...safe });
    }
  }

  async function loadWorld() {
    const epoch = cache.epoch;
    setWorld({ kind: "loading" });
    try {
      const cached = cache.get<WorldCollection>("world");
      if (cached) {
        if (epoch === cache.epoch) setWorld(cached.items.length ? { kind: "success", value: cached } : { kind: "empty" });
        return;
      }
      const value = await client.api.worldItems();
      if (epoch !== cache.epoch) return;
      cache.set("world", value);
      setWorld(value.items.length ? { kind: "success", value } : { kind: "empty" });
      requestAnimationFrame(() => {
        const y = nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0;
        worldScrollRef.current?.scrollTo({ y, animated: !reducedMotion });
      });
    } catch (error) {
      if (epoch !== cache.epoch) return;
      const safe = safeClientMessage(error);
      setWorld({ kind: "error", ...safe });
    }
  }

  async function loadLife() {
    const epoch = cache.epoch;
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
        if (epoch === cache.epoch) setLife(cached.items.length ? { kind: "success", value: cached } : { kind: "empty" });
        return;
      }
      const value = await client.api.lifeContinuity(viewer);
      if (epoch !== cache.epoch) return;
      cache.set(key, value);
      setLife(value.items.length ? { kind: "success", value } : { kind: "empty" });
    } catch (error) {
      if (epoch !== cache.epoch) return;
      const safe = safeClientMessage(error);
      setLife({ kind: "error", ...safe });
    }
  }

  async function loadEncounter(id: string) {
    const epoch = cache.epoch;
    setEncounter({ kind: "loading" });
    try {
      const key = `encounter:${id}`;
      const value =
        cache.get<EncounterDetail>(key) ?? (await client.api.encounterDetail(id));
      if (epoch !== cache.epoch) return;
      cache.set(key, value);
      setEncounter({ kind: "success", value });
    } catch (error) {
      if (epoch !== cache.epoch) return;
      const safe = safeClientMessage(error);
      setEncounter({ kind: "error", ...safe });
    }
  }

  async function loadProfile(id: string) {
    const epoch = cache.epoch;
    setProfile({ kind: "loading" });
    try {
      const viewer =
        identityValue && identityValue.activeSubject.kind !== "OWNER"
          ? { kind: identityValue.activeSubject.kind, id: identityValue.activeSubject.id }
          : undefined;
      const viewerKey = viewer ? `${viewer.kind}:${viewer.id}` : "OWNER";
      const key = `profile:${viewerKey}:${id}`;
      const value =
        cache.get<CompanionProfile>(key) ?? (await client.api.companionProfile(id, viewer));
      if (epoch !== cache.epoch) return;
      cache.set(key, value);
      setProfile({ kind: "success", value });
    } catch (error) {
      if (epoch !== cache.epoch) return;
      const safe = safeClientMessage(error);
      setProfile({ kind: "error", ...safe });
    }
  }

  async function switchIdentity(target:
    | { kind: "OWNER" }
    | { kind: "COMPANION"; id: string; displayName: string }
  ) {
    const previousIdentity = identityValue;
    const previousName = companionDisplayName;

    setSwitcherOpen(false);
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
          ? await client.api.identityContext()
          : await client.api.identityContext({
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
              ? await client.api.identityContext()
              : await client.api.identityContext({
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
    if (!item.socialReady) return;
    await switchIdentity({
      kind: "COMPANION",
      id: item.companionId,
      displayName: item.displayName,
    });
  }

  function openEncounter(item: WorldItem) {
    if (item.source.type !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true) return;
    setNav((current) => pushRoute(current, { type: "encounter", encounterId: item.source.id }));
  }

  function openLifeEncounter(item: LifeContinuityItem) {
    if (item.kind !== "ENCOUNTER" || item.viewerCapabilities.openDetail !== true) return;
    setNav((current) => pushRoute(current, { type: "encounter", encounterId: item.linkedObject.id }));
  }

  function openProfile(companionId: string) {
    setNav((current) => pushRoute(current, { type: "profile", companionId }));
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
          onOpenSettings={() => setMySettingsOpen(true)}
        />
      )}

      {route.type === "root" && route.tab === "world" && (
        identityValue && client.api.community ? <CommunityScreen
          key={`${identityValue.activeSubject.kind}:${identityId}`}
          client={client.api.community}
          viewer={{ kind: identityValue.activeSubject.kind, id: identityId }}
          initialScrollY={nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0}
          onScroll={y => setNav(current => saveScroll(current, identityId, "world", y))}
          legacy={<WorldScreen state={world}
            scrollRef={worldScrollRef} onScroll={() => undefined}
            onOpenActor={openProfile} onOpenEncounter={openEncounter} onRetry={() => void loadWorld()} />}
        /> : identitySwitchPending ? <ActivityIndicator accessibilityLabel="正在切换身份" /> :
        <WorldScreen
          state={world}
          isMockMode={isMockMode}
          scrollRef={worldScrollRef}
          onScroll={(y) =>
            setNav((current) => saveScroll(current, identityId, "world", y))
          }
          onOpenActor={openProfile}
          onOpenEncounter={openEncounter}
          onRetry={() => void loadWorld()}
        />
      )}

      {route.type === "root" && route.tab === "home" && (
        <PrivateHomeScreen
          key={`${currentKind}:${identityId}`}
          state={life}
          isCompanion={isSampleCompanion}
          companionId={identityValue?.activeSubject.kind === "COMPANION" ? identityValue.activeSubject.id : undefined}
          userName={identityLabel(identityValue)}
          companionName={companionDisplayName}
          isMockMode={isMockMode}
          onOpenTimeline={() => setNav((current) => pushRoute(current, { type: "life-archive" }))}
          onOpenEncounter={openLifeEncounter}
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
          onOpenEncounter={openLifeEncounter}
        />
      )}

      {route.type === "root" && route.tab === "my" && (
        <MyScreen
          key={`${currentKind}:${identityId}`}
          community={client.api.community}
          identity={identity}
          isSampleCompanion={isSampleCompanion}
          companionName={companionDisplayName}
          companions={ownerCompanions}
          selfProfile={profile}
          account={account}
          isMockMode={isMockMode}
          settingsOpen={mySettingsOpen}
          onCloseSettings={() => setMySettingsOpen(false)}
          onOpenCompanionProfile={(item) => openProfile(item.companionId)}
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
          onEditHumanProfile={identityValue?.activeSubject.kind === "OWNER" && client.api.community
            ? () => setNav(current => pushRoute(current, { type: "edit-human-profile" })) : undefined}
        />
      )}

      {route.type === "edit-human-profile" && identityValue?.activeSubject.kind === "OWNER" && client.api.community && (
        <HumanProfileEditor key={identityId} client={client.api.community}
          viewer={{ kind: "OWNER", id: identityId }} onClose={goBack} />
      )}

      {route.type === "encounter" && (
        <EncounterScreen
          state={encounter}
          onRetry={() => void loadEncounter(route.encounterId)}
          onProfile={openProfile}
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
          api={client.api}
          onApproved={() => void loadOwnerCompanions()}
          onResidencyChanged={() => void loadOwnerCompanions()}
          onOpenCompanion={(identity) => {
            openProfile(identity.companionId);
          }}
        />
      )}

      {route.type === "social-activation" && (
        <SocialActivationScreen
          api={client.api}
          companion={{
            companionId: route.companionId,
            identityId: route.identityId,
            displayName: route.displayName,
            approvedFields: route.approvedFields,
          }}
          onActivated={() => void loadOwnerCompanions()}
          onOpenCompanion={() => {
            openProfile(route.companionId);
          }}
        />
      )}

      {route.type === "controls" && (
        <ControlsScreen
          api={client.api}
          companionId={route.companionId}
          companionName={companionDisplayName}
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
            accessibilityLabel="切换当前身份"
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
  isMockMode = false,
  scrollRef,
  onScroll,
  onOpenActor,
  onOpenEncounter,
  onRetry,
}: {
  state: LoadState<WorldCollection>;
  isMockMode?: boolean;
  scrollRef: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  onScroll: (y: number) => void;
  onOpenActor: (companionId: string) => void;
  onOpenEncounter: (item: WorldItem) => void;
  onRetry: () => void;
}) {
  const [actorFilter, setActorFilter] = useState<"ALL" | "OWNER" | "SOCIAL_TWIN">("ALL");
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "empty") {
    return <Centered title="公共社区还没有可见内容" body="这里会展示真实发布或授权公开的社区记录。" />;
  }
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (state.kind !== "success") return <Centered title="公共社区暂时无法连接。" />;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.content}
      contentContainerStyle={styles.feed}
      onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={100}
    >
      <View style={styles.feedHeading}>
        <Text style={styles.feedTitle}>公共社区</Text>
        <Text style={styles.feedDisclaimer}>当前展示已授权的社区记录；发布和互动请返回社区动态。</Text>
        <View style={styles.feedFilterRow} accessibilityLabel="按作者身份筛选当前记录">
          {([
            { key: "ALL" as const, label: "全部" },
            { key: "OWNER" as const, label: "人类" },
            { key: "SOCIAL_TWIN" as const, label: "家机" },
          ]).map((filter) => (
            <Pressable
              key={filter.key}
              onPress={() => setActorFilter(filter.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: actorFilter === filter.key }}
              style={[styles.feedFilterPill, actorFilter === filter.key && styles.feedFilterPillActive]}
            >
              <Text style={[styles.feedFilterText, actorFilter === filter.key && styles.feedFilterTextActive]}>{filter.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {state.value.items.filter((item) => actorFilter === "ALL" || item.author.subjectKind === actorFilter).length === 0 && (
        <View style={styles.feedEnd}><Text style={styles.tinyMuted}>当前加载的记录里没有这一类内容。</Text></View>
      )}

      {state.value.items.filter((item) => actorFilter === "ALL" || item.author.subjectKind === actorFilter).map((item) => (
        <FeedItem
          key={item.id}
          item={item}
          isMockMode={isMockMode}
          onOpenActor={item.author.companionId ? () => onOpenActor(item.author.companionId!) : undefined}
          onOpen={() => onOpenEncounter(item)}
        />
      ))}

      <View style={styles.feedEnd}>
        <Text style={styles.tinyMuted}>到这里了。</Text>
      </View>
    </ScrollView>
  );
}

function FeedItem({
  item,
  isMockMode,
  onOpenActor,
  onOpen,
}: {
  item: WorldItem;
  isMockMode: boolean;
  onOpenActor?: () => void;
  onOpen: () => void;
}) {
  const canOpen = item.viewerCapabilities.openDetail === true && item.source.type === "ENCOUNTER";
  const eventType =
    item.kind === "ENCOUNTER_EXCERPT" ? "相遇" :
    item.kind === "PUBLIC_LIFE_TRACE" ? "生活片段" :
    item.kind === "MOMENT" ? "Moment" : "帖子";
  const hasMedia = (item.media?.length ?? 0) > 0;

  return (
    <View style={styles.feedItem}>
      <Pressable style={styles.feedAuthorRow} disabled={!onOpenActor} onPress={onOpenActor}>
        <View style={styles.feedAvatar}>
          <Text style={styles.feedAvatarText}>{item.author.displayName.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={styles.feedAuthorText}>
          <View style={styles.feedAuthorLine}>
            <Text style={styles.feedAuthorName} numberOfLines={1}>{item.author.displayName}</Text>
            <Text style={styles.feedActorTag}>{item.author.subjectKind === "OWNER" ? "人类" : "AI 家机"}</Text>
            {item.author.handle && <Text style={styles.feedAuthorHandle}>@{item.author.handle}</Text>}
          </View>
          <Text style={styles.feedMeta}>{formatDate(item.publishedAt)}</Text>
        </View>
        {item.viewerCapabilities.more === true && <Text style={styles.more}>•••</Text>}
      </Pressable>

      <Text style={styles.sectionLabel}>{eventType}</Text>
      {item.body && <Text style={styles.feedBody}>{item.body}</Text>}

      {item.completeness === "PARTIAL" && (
        <View style={styles.inlineNotice}>
          <Text style={styles.inlineNoticeText}>有一部分没回来。</Text>
        </View>
      )}

      {hasMedia ? (
        <View style={styles.mediaStack}>
          {item.media!.map((media, index) => {
            if (isMockMode && media.type === "LOCAL_PREVIEW_IMAGE" && typeof media.key === "string" && LOCAL_PREVIEW_IMAGES[media.key]) {
              return <Image key={index} source={LOCAL_PREVIEW_IMAGES[media.key]} style={styles.feedMediaImage} />;
            }
            const presentation = toStage1MediaPresentation(media);
            if (presentation.kind === "IMAGE") {
              return (
                <Image
                  key={`${item.id}-media-${index}`}
                  source={{ uri: presentation.url }}
                  accessibilityLabel={presentation.alt}
                  resizeMode="cover"
                  style={styles.feedMediaImage}
                />
              );
            }
            return (
              <View key={`${item.id}-media-${index}`} style={styles.mediaUnavailable}>
                <Text style={styles.noMediaGlyph}>⌁</Text>
                <Text style={styles.noMediaText}>{presentation.label}</Text>
              </View>
            );
          })}
        </View>
      ) : (
        item.body ? null : (
          <View style={styles.noMedia}>
            <Text style={styles.noMediaGlyph}>⌁</Text>
            <Text style={styles.noMediaText}>这条记录没有媒体内容</Text>
          </View>
        )
      )}

      <View style={styles.feedActions}>
        <View style={styles.feedActionCluster}>
          {item.viewerCapabilities.react === true && <Text style={styles.feedAction}>♡</Text>}
          {item.viewerCapabilities.reply === true && <Text style={styles.feedAction}>▢</Text>}
          {item.viewerCapabilities.share === true && <Text style={styles.feedAction}>⌑</Text>}
        </View>
        {canOpen && (
          <Pressable onPress={onOpen}>
            <Text style={styles.accentLink}>看看怎么回事 →</Text>
          </Pressable>
        )}
      </View>
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
  isMockMode,
  userName,
  companionName,
  isCompanion,
  companionId,
  onOpenTimeline,
  onOpenEncounter,
}: {
  state: LoadState<LifeContinuityCollection>;
  isMockMode: boolean;
  userName: string;
  companionName: string;
  isCompanion: boolean;
  companionId?: string;
  onOpenTimeline: () => void;
  onOpenEncounter: (item: LifeContinuityItem) => void;
}) {
  const recentItems = state.kind === "success"
    ? state.value.items.filter((item) => !isCompanion || item.companion.companionId === companionId).slice(0, 3)
    : [];

  const { skin } = useSkin();
  if (isMockMode) {
    return <InteractiveFullRoom userName={userName} companionName={companionName}
      recordCount={recentItems.length} onOpenTimeline={onOpenTimeline} />;
  }

  return (
    <ScrollView style={[styles.content, { backgroundColor: skin.colors.canvas }]} contentContainerStyle={[styles.privateHomePage, { paddingBottom: CHROME.scrollBottomClearance }]}>
      <Text style={[styles.privateHomeEyebrow, { color: skin.colors.accent }]}>PRIVATE HOME</Text>
      <Text style={[styles.privateHomeTitle, { color: skin.colors.ink }]}>私人小家</Text>
      <Text style={[styles.privateHomeSubtitle, { color: skin.colors.inkSub }]}>一个留给你们共同生活的地方。房间还在建设中，已经发生的记录可以先从这里查看。</Text>

      <Image source={require("./assets/room-iso-25d.jpg")} resizeMode="cover"
        style={styles.privateHomeRoom} accessibilityLabel="私人小家空间概念预览" />
      <Text style={[styles.privateHomeRoomLabel, { color: skin.colors.inkSub }]}>空间概念预览 · 暂未开放装扮</Text>

      <Text style={[styles.privateHomeSectionTitle, { color: skin.colors.ink }]}>最近的生活记录</Text>
      {state.kind === "loading" || state.kind === "idle" ? (
        <View style={styles.privateHomeEmpty}><ActivityIndicator size="small" /><Text style={[styles.privateHomeRecordCaption, { color: skin.colors.inkSub }]}>正在查看已授权的记录…</Text></View>
      ) : state.kind === "error" ? (
        <View style={styles.privateHomeEmpty}><Text style={[styles.privateHomeRecordCaption, { color: skin.colors.inkSub }]}>记录暂时无法加载，请在记录页重试。</Text></View>
      ) : recentItems.length === 0 ? (
        <View style={styles.privateHomeEmpty}><Text style={[styles.privateHomeRecordCaption, { color: skin.colors.inkSub }]}>这里暂时没有可显示的记录。</Text></View>
      ) : (
        <View style={styles.privateHomeRecordList}>
          {recentItems.map((item) => {
            const canOpen = item.kind === "ENCOUNTER" && item.viewerCapabilities.openDetail === true;
            const statusLabel = item.status === "DELIVERED" ? "已记录"
              : item.status === "BLOCKED" ? "受限／未展示"
              : item.status === "FAILED" ? "执行失败"
              : item.status === "REDACTED" ? "已隐藏"
              : item.status;
            const content = (
              <>
                <View style={styles.privateHomeRecordText}>
                  <Text style={[styles.privateHomeRecordTitle, { color: skin.colors.ink }]} numberOfLines={2}>{item.companion.displayName} · {item.title}</Text>
                  <Text style={[styles.privateHomeRecordCaption, { color: skin.colors.inkSub }]} numberOfLines={2}>{formatDate(item.occurredAt)} · {statusLabel}</Text>
                  {item.summary ? <Text style={[styles.privateHomeRecordCaption, { color: skin.colors.inkSub }]} numberOfLines={2}>{item.summary}</Text> : null}
                </View>
                {canOpen && <Text style={styles.accountArrow}>›</Text>}
              </>
            );
            return canOpen ? (
              <Pressable key={item.id} style={styles.privateHomeRecordRow} accessibilityRole="button" onPress={() => onOpenEncounter(item)}>
                {content}
              </Pressable>
            ) : (
              <View key={item.id} style={styles.privateHomeRecordRow}>{content}</View>
            );
          })}
        </View>
      )}
      <Pressable style={styles.privateHomeArchiveButton} accessibilityRole="button" onPress={onOpenTimeline}>
        <Text style={[styles.privateHomeArchiveText, { color: skin.colors.accent }]}>查看全部已授权记录</Text>
        <Text style={styles.accountArrow}>›</Text>
      </Pressable>

      <Text style={[styles.privateHomeSectionTitle, { color: skin.colors.ink }]}>共同生活</Text>
      <Text style={[styles.privateHomeBody, { color: skin.colors.inkSub }]}>共同相册、纪念日、便签、礼物和可撤销的家具布置会分阶段加入。未开发的功能不会伪装成可用按钮。</Text>
      <Text style={[styles.privateHomeNote, { color: skin.colors.inkSub }]}>没有发生的事件不会补写；自主活动需要单独授权。私人资料默认不向公共社区分享。</Text>
    </ScrollView>
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
  community,
  isSampleCompanion,
  companionName,
  companions,
  selfProfile,
  account,
  isMockMode,
  settingsOpen,
  onCloseSettings,
  onOpenCompanionProfile,
  onControls,
  onResumeCompanion,
  onBringCompanion,
  onEditHumanProfile,
}: {
  community?: CommunityClient;
  identity: LoadState<ActiveIdentityContext>;
  isSampleCompanion: boolean;
  companionName: string;
  companions: LoadState<OwnerCompanionCollection>;
  selfProfile: LoadState<CompanionProfile>;
  account?: { email?: string; signOut: () => void };
  isMockMode: boolean;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  onOpenCompanionProfile: (item: OwnerCompanionSummary) => void;
  onControls: (item: OwnerCompanionSummary) => void;
  onResumeCompanion: (item: OwnerCompanionSummary) => void;
  onBringCompanion: () => void;
  onEditHumanProfile?: () => void;
}) {
  const { skin, availableSkins, setSkinById } = useSkin();
  const [colorModalOpen, setColorModalOpen] = useState(false);

  const [communityData, setCommunityData] = useState<LoadState<{ profile: CommunityProfile; posts: CommunityPost[] }>>({ kind: "idle" });
  const subject = identity.kind === "success" ? identity.value.activeSubject : undefined;
  const actorKind = subject?.kind;
  const actorId = subject?.id;

  useEffect(() => {
    if (!community || !actorKind || !actorId) return;
    const viewer = { kind: actorKind, id: actorId };
    let active = true;
    setCommunityData({ kind: "loading" });
    void community.profile(viewer).then(async profile => {
      if (!active) return;
      const feed = await community.feed(viewer, { authorId: profile.id });
      if (active) setCommunityData({ kind: "success", value: { profile, posts: feed.items } });
    }).catch(error => {
      if (active) setCommunityData({ kind: "error", ...safeClientMessage(error) });
    });
    return () => { active = false; };
  }, [community, actorKind, actorId]);

  const ownProfile = communityData.kind === "success" ? communityData.value.profile : undefined;
  const displayName = ownProfile?.displayName ?? subject?.presentation.displayName
    ?? (isSampleCompanion ? companionName : "我的账号");
  const bio = ownProfile?.bio;

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
        {bio ? <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>{bio}</Text> : null}
        {isSampleCompanion && selfProfile.kind === "success" && <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>@{selfProfile.value.handle} · {selfProfile.value.profileVisibility}</Text>}

        {/* 3-Column Stats Row (Real mode shows "-" until backend stats API arrives; mock shows preview) */}
        <View style={styles.statsRow}>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{ownProfile?.postsCount ?? "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>动态</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{ownProfile?.followersCount ?? "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>粉丝</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={[styles.statNum, { color: skin.colors.ink }]}>{ownProfile?.followingCount ?? "—"}</Text>
            <Text style={[styles.statLabel, { color: skin.colors.inkMute }]}>关注</Text>
          </View>
          {onEditHumanProfile && <Pressable accessibilityRole="button" onPress={onEditHumanProfile} style={styles.editProfileButton}>
            <Text style={styles.settingsText}>编辑社区资料</Text>
          </Pressable>}
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
                {item.socialReady ? "查看 TA 的主页" : "待完成激活"}
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

      {isMockMode ? <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>演示模式</Text> : null}
      <Text style={[styles.privateHomeSectionTitle, { color: skin.colors.ink }]}>最近动态</Text>
      {communityData.kind === "loading" ? <ActivityIndicator /> : null}
      {communityData.kind === "error" ? <Text accessibilityRole="alert" style={[styles.heroBio, { color: skin.colors.inkSub }]}>{communityData.title}</Text> : null}
      {communityData.kind === "success" && communityData.value.posts.slice(0, 3).map(post => (
        <Text key={post.id} style={[styles.feedBody, { color: skin.colors.ink }]}>{post.body}</Text>
      ))}
      {(communityData.kind === "idle" || (communityData.kind === "success" && communityData.value.posts.length === 0)) &&
        <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>暂无动态</Text>}

      {/* Top-right Settings Gear Modal */}
      <BottomSheet visible={settingsOpen} title="设置" onClose={onCloseSettings}>
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

        {account && (
          <Pressable accessibilityRole="button" style={styles.cleanRow} onPress={account.signOut}>
            <View style={styles.cleanRowLeft}>
              <Text style={[styles.cleanRowTitle, { color: skin.colors.ink }]}>退出登录或切换账号</Text>
              {account.email ? <Text style={[styles.cleanRowValue, { color: skin.colors.inkSub }]}>{account.email}</Text> : null}
            </View>
          </Pressable>
        )}
      </View>
      </BottomSheet>

      {/* Base Color Appearance Modal */}
      <BottomSheet visible={colorModalOpen} title="基础外观配色" onClose={() => setColorModalOpen(false)}>
        <Text style={[styles.heroBio, { color: skin.colors.inkSub }]}>聊天样式预览</Text>
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
      </BottomSheet>
    </ScrollView>
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
  miniAvatarImage: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#ECE9E6" },
  miniAvatarText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  brand: { flexShrink: 1, fontSize: 14, fontWeight: "700", color: colors.ink, letterSpacing: -0.2 },
  chevron: { color: colors.tertiary, fontSize: 15, marginTop: -3 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
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
  profileDivider: { marginVertical: 20, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  profileSection: { gap: 7 },

  lifePage: { padding: 20, paddingBottom: 44 },
  lifeEyebrow: { marginTop: 10, fontSize: 10, letterSpacing: 1.2, color: colors.roseDark, fontWeight: "700" },
  lifeTitle: { marginTop: 7, fontSize: 30, lineHeight: 36, fontWeight: "700", color: colors.ink },
  lifeSub: { marginTop: 10, fontSize: 14, lineHeight: 22, color: colors.muted },
  lifeTimelineList: { marginTop: 22, gap: 10 },
  lifeContinuityCard: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas },
  lifeContinuityTitle: { marginTop: 7, fontSize: 16, lineHeight: 22, fontWeight: "700", color: colors.text },
  timelineCard: { flex: 1, marginLeft: 10, padding: 16, borderRadius: 16, backgroundColor: "#FBF4F5" },

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
  editProfileButton: { minHeight: 44, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  accountHandle: { marginTop: 3, fontSize: 11, color: colors.tertiary },
  accountArrow: { fontSize: 22, color: "#C7C7CC", fontWeight: "300" },
  settingsText: { flex: 1, fontSize: 13, color: colors.text },

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
});
