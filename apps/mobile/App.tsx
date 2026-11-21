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

type LoadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "success"; value: T }
  | { kind: "empty" }
  | { kind: "error"; title: string; retry: boolean };

const cache = new ViewerSensitiveCache();

function actionAllowed(capabilities: Record<string, boolean>, ...keys: string[]): boolean {
  return keys.some((key) => capabilities[key] === true);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function identityLabel(identity?: ActiveIdentityContext): string {
  return identity?.activeSubject.presentation.displayName ?? "本人";
}

export default function App() {
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
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />

      {!isMoment && (
        <AppHeader
          routeIsRoot={route.type === "root"}
          identityTitle={identityLabel(identityValue)}
          isSampleCompanion={isSampleCompanion}
          identity={identity}
          onBack={goBack}
          onIdentity={() => setSwitcherOpen(true)}
        />
      )}

      {route.type === "root" && route.tab === "world" && (
        <WorldScreen
          state={world}
          isSampleCompanion={isSampleCompanion}
          companionName={companionDisplayName}
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
        <BottomTabs
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
  identityTitle,
  isSampleCompanion,
  identity,
  onBack,
  onIdentity,
}: {
  routeIsRoot: boolean;
  identityTitle: string;
  isSampleCompanion: boolean;
  identity: LoadState<ActiveIdentityContext>;
  onBack: () => void;
  onIdentity: () => void;
}) {
  const avatar = identity.kind === "success" ? identity.value.activeSubject.presentation.avatar : undefined;
  const initial = identityTitle.slice(0, 1).toUpperCase();

  return (
    <View style={styles.topBar}>
      {routeIsRoot ? (
        <Pressable style={styles.identityTrigger} onPress={onIdentity} accessibilityRole="button" accessibilityLabel="切换当前账号">
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.miniAvatarImage} />
          ) : (
            <View style={[styles.miniAvatar, isSampleCompanion && styles.miniAvatarSampleCompanion]}>
              <Text style={styles.miniAvatarText}>{initial}</Text>
            </View>
          )}
          <Text style={styles.brand} numberOfLines={1}>{identityTitle}</Text>
          <Text style={styles.chevron}>⌄</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.iconButton} onPress={onBack}>
          <Text style={styles.backIcon}>‹</Text>
        </Pressable>
      )}

      <View style={styles.headerRight}>
        {routeIsRoot && <Text style={styles.headerIdentityTag}>{isSampleCompanion ? "家机身份" : "人类身份"}</Text>}
        {identity.kind === "loading" && <ActivityIndicator size="small" />}
      </View>
    </View>
  );
}

function WorldScreen({
  state,
  isSampleCompanion,
  companionName,
  scrollRef,
  onScroll,
  onOpenActor,
  onOpenEncounter,
  onRetry,
}: {
  state: LoadState<WorldCollection>;
  isSampleCompanion: boolean;
  companionName: string;
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
        <Text style={styles.feedDisclaimer}>当前展示已授权的社区记录；发帖、评论与关注等功能仍在开发中。</Text>
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
  onOpenActor,
  onOpen,
}: {
  item: WorldItem;
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
  onOpenTimeline,
  onOpenEncounter,
}: {
  state: LoadState<LifeContinuityCollection>;
  isCompanion: boolean;
  companionId?: string;
  onOpenTimeline: () => void;
  onOpenEncounter: (item: LifeContinuityItem) => void;
}) {
  const recentItems = state.kind === "success"
    ? state.value.items.filter((item) => !isCompanion || item.companion.companionId === companionId).slice(0, 3)
    : [];

  return (
    <ScrollView style={styles.content} contentContainerStyle={styles.privateHomePage}>
      <Text style={styles.privateHomeEyebrow}>PRIVATE HOME</Text>
      <Text style={styles.privateHomeTitle}>私人小家</Text>
      <Text style={styles.privateHomeSubtitle}>一个留给你们共同生活的地方。房间还在建设中，已经发生的记录可以先从这里查看。</Text>

      <View style={styles.privateHomeRoom} accessible accessibilityLabel="私人小家静态空间概念预览">
        <View style={styles.privateHomeWindow}>
          <Text style={styles.privateHomeWindowSymbol}>☼</Text>
        </View>
        <View style={styles.privateHomeShelf} />
        <View style={styles.privateHomeSofa} />
        <View style={styles.privateHomeFloor} />
        <Text style={styles.privateHomeRoomLabel}>空间概念预览 · 暂未开放装扮</Text>
      </View>

      <Text style={styles.privateHomeSectionTitle}>最近的生活记录</Text>
      {state.kind === "loading" || state.kind === "idle" ? (
        <View style={styles.privateHomeEmpty}><ActivityIndicator size="small" /><Text style={styles.privateHomeRecordCaption}>正在查看已授权的记录…</Text></View>
      ) : state.kind === "error" ? (
        <View style={styles.privateHomeEmpty}><Text style={styles.privateHomeRecordCaption}>记录暂时无法加载，请在记录页重试。</Text></View>
      ) : recentItems.length === 0 ? (
        <View style={styles.privateHomeEmpty}><Text style={styles.privateHomeRecordCaption}>这里暂时没有可显示的记录。</Text></View>
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
                  <Text style={styles.privateHomeRecordTitle} numberOfLines={2}>{item.companion.displayName} · {item.title}</Text>
                  <Text style={styles.privateHomeRecordCaption} numberOfLines={2}>{formatDate(item.occurredAt)} · {statusLabel}</Text>
                  {item.summary ? <Text style={styles.privateHomeRecordCaption} numberOfLines={2}>{item.summary}</Text> : null}
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
        <Text style={styles.privateHomeArchiveText}>查看全部已授权记录</Text>
        <Text style={styles.accountArrow}>›</Text>
      </Pressable>

      <Text style={styles.privateHomeSectionTitle}>共同生活</Text>
      <Text style={styles.privateHomeBody}>共同相册、纪念日、便签、礼物和可撤销的家具布置会分阶段加入。未开发的功能不会伪装成可用按钮。</Text>
      <Text style={styles.privateHomeNote}>没有发生的事件不会补写；自主活动需要单独授权。私人资料默认不向公共社区分享。</Text>
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
  isSampleCompanion,
  companionName,
  companions,
  selfProfile,
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
  onOpenCompanionProfile: (item: OwnerCompanionSummary) => void;
  onControls: (item: OwnerCompanionSummary) => void;
  onResumeCompanion: (item: OwnerCompanionSummary) => void;
  onBringCompanion: () => void;
}) {
  const ownerName = identity.kind === "success" ? identity.value.activeSubject.presentation.displayName : "我的账号";
  return (
    <ScrollView style={styles.content} contentContainerStyle={styles.myPage}>
      <Text style={styles.myTitle}>我的</Text>
      <Text style={styles.mySub}>{isSampleCompanion ? "家机主页" : "人类主页"}</Text>

      {isSampleCompanion ? (
        <View style={styles.accountCard}>
          <View style={[styles.accountAvatar, styles.accountAvatarSampleCompanion]}>
            <Text style={styles.accountAvatarText}>{companionName.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.accountCardText}>
            <Text style={styles.accountName}>{companionName}</Text>
            <Text style={styles.accountHandle}>
              {selfProfile.kind === "success"
                ? `@${selfProfile.value.handle} · ${selfProfile.value.viewer.relationship === "SELF" ? "自己" : "当前视角"}`
                : selfProfile.kind === "error"
                  ? "主页没回来。"
                  : "稍等。"}
            </Text>
            {selfProfile.kind === "success" && (
              <Text style={styles.tinyMuted}>谁能看到 · {selfProfile.value.profileVisibility}</Text>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.accountCard}>
          <View style={[styles.accountAvatar, isSampleCompanion && styles.accountAvatarSampleCompanion]}>
            <Text style={styles.accountAvatarText}>{ownerName.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.accountCardText}>
            <Text style={styles.accountName}>{ownerName}</Text>
            <Text style={styles.accountHandle}>人类账号 · 当前身份</Text>
          </View>
        </View>
  
  
      )}

      {!isSampleCompanion && (
        <>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeader}>我的家机</Text>
          </View>

          {companions.kind === "loading" && (
            <Text style={styles.tinyMuted}>稍等。</Text>
          )}
          {companions.kind === "error" && (
            <Text style={styles.tinyMuted}>家机名单没回来。</Text>
          )}
          {companions.kind === "empty" && (
            <Text style={styles.tinyMuted}>这里还没有家机。</Text>
          )}
          {companions.kind === "success" && companions.value.items.map((item: OwnerCompanionSummary) => {
            const switchable = item.socialReady;
            return (
              <View key={item.companionId} style={styles.partnerContainer}>
                <Pressable
                  style={[styles.partnerRow, styles.partnerMain]}
                  onPress={switchable ? () => onOpenCompanionProfile(item) : () => onResumeCompanion(item)}
                >
                  <View style={[styles.partnerAvatar, styles.accountAvatarSampleCompanion]}>
                    <Text style={styles.accountAvatarText}>{item.displayName.slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={styles.partnerText}>
                    <Text style={styles.partnerName}>{item.displayName}</Text>
                    <Text style={styles.accountHandle}>
                      {item.socialReady ? "查看主页" : "已经到了。还差一步。"}
                    </Text>
                  </View>
                  <Text style={styles.accountArrow}>›</Text>
                </Pressable>
                {item.socialReady && (
                  <Pressable style={styles.partnerSettings} onPress={() => onControls(item)}>
                    <Text style={styles.partnerSettingsText}>设置</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </>
      )}

      {!isSampleCompanion && (
        <View style={styles.settingsGroup}>
          <Pressable style={styles.settingsRow} onPress={onBringCompanion}>
            <Text style={styles.settingsIcon}>＋</Text>
            <Text style={styles.settingsText}>带家机来</Text>
            <Text style={styles.accountArrow}>›</Text>
          </Pressable>
          <View style={styles.settingsRowStatic}>
            <Text style={styles.settingsIcon}>○</Text>
            <View style={styles.settingsStaticText}>
              <Text style={styles.settingsText}>更多设置</Text>
              <Text style={styles.tinyMuted}>还没长出来。先不装按钮。</Text>
            </View>
          </View>
        </View>
      )}
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
          <Text style={styles.sheetTitle}>换个身份</Text>
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

          <View style={styles.sheetFootnote}>
            <Text style={styles.tinyMuted}>换过去，看到的也会跟着换。</Text>
          </View>
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
          <Text style={styles.secondaryPillText}>RETRY RETRY</Text>
        </Pressable>
      )}
    </View>
  );
}

const colors = {
  canvas: "#FFFFFF",
  paper: "#FAF9FE",
  ink: "#000000",
  text: "#1A1B1F",
  muted: "#666666",
  tertiary: "#8E8E93",
  line: "#EFEFF4",
  soft: "#F4F3F8",
  rose: "#D9777F",
  roseDark: "#C8656F",
  roseWash: "#FBEFF0",
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
});
