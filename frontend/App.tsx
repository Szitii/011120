import AsyncStorage from "@react-native-async-storage/async-storage";
import { createChatDraftStore } from "./src/chat/draftStore";
import type { Badges, PlatformFeatures } from "../contracts/chat";
import { useAppIsActive } from "./src/state/useAppIsActive";
import { ConnectionForm } from "./src/onboarding/ConnectionForm";
import { BringCompanionScreen } from "./src/onboarding/BringCompanionScreen";
import { useThemedStyles } from "./src/theme/SkinProvider";
import type { UiPalette } from "./src/theme/skinTokens";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { createClientBootstrap, type ClientBootstrap } from "./src/adapters";
import { ApiProblemError, RealApiAdapter, safeClientMessage } from "./src/adapters/real-api";
import { AccountGate } from "./src/auth/AccountGate";
import type { AccountBinding, SelfServiceResult } from "./src/auth/account-session";
import type { CommunityPost, CommunityProfile } from "../contracts/community";
import { AuthPostImage, CommunityButton, SecondaryHeading } from "./src/community/components";
import { ChatSettingsScreen } from "./src/chat/ChatSettingsScreen";
import { FeedbackScreen } from "./src/feedback/FeedbackScreen";
import { CreateGroupScreen } from "./src/messages/CreateGroupScreen";
import { ComposePostScreen } from "./src/community/ComposePostScreen";
import { CommunityScreen, type ManagedProfileActions } from "./src/community/CommunityScreen";
import { AgentDraftsScreen } from "./src/community/AgentDraftsScreen";
import { AgentSettingsScreen } from "./src/community/AgentSettingsScreen";
import { CommunityFollowList, type FollowDirection } from "./src/community/CommunityFollowList";
import { isAgentViewer, type CommunityClient } from "./src/community/client";
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
  type RootTab,
  type Route,
  type CommunityTarget,
} from "./src/state/navigation";
import { SkinProvider, useSkin } from "./src/theme/SkinProvider";
import { CHROME, RADIUS } from "./src/theme/layoutTokens";
import { LiquidGlassSurface } from "./src/components/LiquidGlassSurface";
import { PixelAvatar } from "./src/components/PixelAvatar";
import { UnifiedProfileView } from "./src/components/UnifiedProfileView";
import { PresetAvatarPicker } from "./src/components/PresetAvatarPicker";
import { FloatingGlassTabs } from "./src/components/FloatingGlassTabs";
import { PrivateHomeScreen } from "./src/home/PrivateHomeScreen";
import { MessagesScreen } from "./src/messages/MessagesScreen";
import { AlbumScreen } from "./src/album/AlbumScreen";
import { addAlbumQuote } from "./src/album/store";
import { DiaryScreen } from "./src/diary/DiaryScreen";
import { ChatScreen } from "./src/chat/ChatScreen";
import { LegalScreen } from "./src/settings/LegalScreen";
import { SettingsScreen } from "./src/settings/SettingsScreen";

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

function formatDate(value: string): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function identityLabel(identity?: ActiveIdentityContext, ownerNickname?: string): string {
  const subject = identity?.activeSubject;
  const name = subject?.presentation.displayName;
  if (subject?.kind === "OWNER") return ownerNickname ?? (name && name !== "Owner" ? name : "本人");
  return name ?? "本人";
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
      baseUrl={config.baseUrl} supabaseUrl={config.supabaseUrl} publishableKey={config.publishableKey}
      account={account} onSignOut={onSignOut} />}
  </AccountGate>;
}

function SignedInWorld({ baseUrl, supabaseUrl, publishableKey, account, onSignOut }: {
  baseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  account: AccountBinding;
  onSignOut: () => void;
}) {
  const client = useMemo(
    () => ({ api: new RealApiAdapter({ baseUrl, supabaseUrl, publishableKey, session: account.tokens }) }),
    [baseUrl, supabaseUrl, publishableKey, account],
  );
  return (
    <WorldApp
      client={client}
      isMockMode={false}
      account={{ email: account.email, signOut: onSignOut, updatePassword: account.updatePassword }}
    />
  );
}

function WorldApp({ client, account, isMockMode }: {
  client: ClientBootstrap;
  isMockMode: boolean;
  account?: {
    email?: string;
    signOut: () => void;
    updatePassword?: (password: string) => Promise<SelfServiceResult>;
  };
}) {
  const styles = useThemedStyles(createStyles);
  const { skin, ui } = useSkin();
  const [cache] = useState(() => new ViewerSensitiveCache());
  const [chatDrafts] = useState(() => createChatDraftStore());
  const [nav, setNav] = useState<NavigationState>(initialNavigationState);
  const [identity, setIdentity] = useState<LoadState<ActiveIdentityContext>>({ kind: "loading" });
  const [world, setWorld] = useState<LoadState<WorldCollection>>({ kind: "idle" });
  const [encounterResult, setEncounterResult] = useState<{ key: string; state: LoadState<EncounterDetail> }>();
  const [profileResult, setProfileResult] = useState<{ key: string; state: LoadState<CompanionProfile> }>();
  const [life, setLife] = useState<LoadState<LifeContinuityCollection>>({ kind: "idle" });
  const [ownerCompanions, setOwnerCompanions] = useState<LoadState<OwnerCompanionCollection>>({ kind: "idle" });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [momentMode, setMomentMode] = useState(false);
  const [identitySwitchPending, setIdentitySwitchPending] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [companionDisplayName, setCompanionDisplayName] = useState("我的家机");
  const [communityRevision, setCommunityRevision] = useState(0);
  const invalidateCommunity = useCallback(() => setCommunityRevision(value => value + 1), []);
  const [companionDeleteRevision, setCompanionDeleteRevision] = useState(0);
  const [createdHome, setCreatedHome] = useState<OwnerCompanionSummary>();
  const [selectedHomeCompanionId, setSelectedHomeCompanionId] = useState<string>();
  const ownerCompanionsRequest = useRef(0);
  const worldScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const route = nav.stack[nav.stack.length - 1] ?? {
    type: "root" as const,
    tab: "world" as const,
  };
  const identityValue = identity.kind === "success" ? identity.value : undefined;
  const identityId = identityValue?.activeSubject.id ?? "anonymous";
  const subject = identityValue?.activeSubject;
  const viewer = subject && { kind: subject.kind, id: subject.id };
  const agentViewer = isAgentViewer(viewer) ? viewer : undefined;
  const canUseChat = viewer?.kind === "OWNER" && !identitySwitchPending && !!client.api.chat;
  const availableCompanions = ownerCompanions.kind === "success" ? ownerCompanions.value.items : [];
  const avatarCompanion = route.type === "avatar-settings" && route.companionId
    ? availableCompanions.find(item => item.companionId === route.companionId) : undefined;
  const editingOwnerProfile = route.type === "edit-human-profile"
    || (route.type === "avatar-settings" && nav.stack.at(-2)?.type === "edit-human-profile");
  const ownerId = viewer?.kind === "OWNER" && !identitySwitchPending ? identityValue?.viewer.ownerId : undefined;
  const homeSelectionKey = identityValue?.viewer.ownerId ? `companion:home-selected:v1:${identityValue.viewer.ownerId}` : undefined;
  const homeSelectionTouched = useRef(false);
  const [homeSelectionLoaded, setHomeSelectionLoaded] = useState(false);
  useEffect(() => {
    if (!homeSelectionKey) return;
    let current = true;
    void AsyncStorage.getItem(homeSelectionKey).then(val => {
      if (current && val && !homeSelectionTouched.current) setSelectedHomeCompanionId(val);
    }).catch(() => undefined).finally(() => { if (current) setHomeSelectionLoaded(true); });
    return () => { current = false; };
  }, [homeSelectionKey]);
  const selectHomeCompanion = useCallback((companionId: string) => {
    if (!ownerId || (createdHome?.companionId !== companionId
      && !availableCompanions.some(item => item.companionId === companionId))) return;
    homeSelectionTouched.current = true;
    setSelectedHomeCompanionId(companionId);
    if (homeSelectionKey) void AsyncStorage.setItem(homeSelectionKey, companionId).catch(() => undefined);
  }, [homeSelectionKey, ownerId, availableCompanions, createdHome?.companionId]);
  const homeCompanion = ownerId ? (
    availableCompanions.find(item => item.companionId === selectedHomeCompanionId)
    ?? (createdHome?.companionId === selectedHomeCompanionId ? createdHome : undefined)
    ?? availableCompanions[0]
    ?? createdHome
  ) : undefined;
  useEffect(() => {
    if (!homeSelectionLoaded || !ownerId || !homeSelectionKey
      || (ownerCompanions.kind !== "success" && ownerCompanions.kind !== "empty")) return;
    const next = homeCompanion?.companionId;
    if (selectedHomeCompanionId === next) return;
    setSelectedHomeCompanionId(next);
    void (next ? AsyncStorage.setItem(homeSelectionKey, next) : AsyncStorage.removeItem(homeSelectionKey)).catch(() => undefined);
  }, [homeSelectionLoaded, ownerId, homeSelectionKey, ownerCompanions.kind, homeCompanion?.companionId, selectedHomeCompanionId]);
  const worldVisible = route.type === "root" && route.tab === "world";
  const homeScope = ownerId && homeCompanion ? { ownerId, companionId: homeCompanion.companionId } : undefined;
  const diaryClient = viewer?.kind === "OWNER" && !identitySwitchPending ? client.api.diary : undefined;
  const profileTarget = route.type === "community-target" && route.target.type === "profile" ? route.target : undefined;
  const managedCompanion = ownerId && profileTarget?.companionId
    ? availableCompanions.find(item => item.companionId === profileTarget.companionId)
      ?? (createdHome?.companionId === profileTarget.companionId ? createdHome : undefined)
    : undefined;
  const profileId = profileTarget?.companionId && !managedCompanion ? profileTarget.companionId
    : route.type === "root" && route.tab === "my" && viewer?.kind === "COMPANION" ? viewer.id
    : undefined;
  const encounterId = route.type === "encounter" ? route.encounterId : undefined;
  const viewerKey = `${viewer?.kind}:${identityId}`;
  const appActive = useAppIsActive();
  const authenticatedOwner = identityValue?.viewer.ownerId;
  const [ownerProfile, setOwnerProfile] = useState<{ id: string; name?: string; avatar: string | null }>();
  const ownProfile = ownerProfile?.id === authenticatedOwner ? ownerProfile : undefined;
  const ownerNickname = ownProfile?.name;
  const ownerAvatar = ownProfile ? ownProfile.avatar : subject?.kind === "OWNER" ? subject.presentation.avatar : undefined;
  const activeCompanion = availableCompanions.find(item => subject?.kind === "COMPANION" ? item.companionId === subject.id
    : subject?.kind === "SOCIAL_TWIN" && item.socialTwinId === subject.id);
  const activeAvatar = subject?.kind === "OWNER" ? ownerAvatar
    : activeCompanion ? activeCompanion.avatar ?? null : subject?.presentation.avatar;
  const settingsViewer = route.type === "agent-settings" && route.companionId && ownerId
    ? { kind: "COMPANION" as const, id: route.companionId } : agentViewer;
  const [profileRevision, reloadOwnerProfile] = useState(0);
  const ownerProfileRequest = useRef(0);
  useEffect(() => {
    const community = client.api.community;
    if (!authenticatedOwner || !community) return;
    const request = ++ownerProfileRequest.current;
    void community.profile({ kind: "OWNER", id: authenticatedOwner }).then(profile => {
      if (request === ownerProfileRequest.current) setOwnerProfile({ id: authenticatedOwner, name: profile.displayName, avatar: profile.avatar });
    }).catch(() => undefined);
    return () => { ownerProfileRequest.current++; };
  }, [authenticatedOwner, client.api, profileRevision]);
  const [features, setFeatures] = useState<PlatformFeatures>();
  const [featureRevision, setFeatureRevision] = useState(0);
  const refreshFeatures = useCallback(() => setFeatureRevision(value => value + 1), []);
  useEffect(() => {
    if (!appActive || !authenticatedOwner || !client.api.chat?.features) {
      setFeatures(undefined);
      return;
    }
    let current = true;
    void client.api.chat.features().then(value => {
      if (current) setFeatures(value);
    }).catch(() => {
      if (current) setFeatures(undefined);
    });
    return () => { current = false; };
  }, [appActive, authenticatedOwner, client.api, featureRevision]);
  const groupCreateEnabled = features?.groupChatCreate === true;
  const groupSendEnabled = features?.groupChatSend === true;
  const connectionsEnabled = features?.connections === true;
  const [badgeRevision, setBadgeRevision] = useState(0);
  const [badgeState, setBadgeState] = useState<{ key: string; data: Badges }>();
  const refreshBadges = useCallback(() => setBadgeRevision(value => value + 1), []);
  useEffect(() => {
    if (!appActive || !subject || !client.api.chat?.badges) return;
    let current = true;
    void client.api.chat.badges().then(data => {
      if (current) setBadgeState({ key: viewerKey, data });
    }).catch(() => { /* Keep the last badge count during a transient failure. */ });
    return () => { current = false; };
  }, [appActive, viewerKey, nav.rootTab, badgeRevision, client.api]);
  const badgeData = badgeState?.key === viewerKey ? badgeState.data : undefined;
  const communityUnread = badgeData?.community.find(row => row.actorId === identityId)?.unread ?? 0;
  const unread = communityUnread + (ownerId ? (badgeData?.chats ?? 0) + (badgeData?.ownerInbox ?? 0) : 0);
  const feedbackUnread = ownerId ? (badgeData?.feedback ?? 0) : 0;
  const profileKey = profileId ? `${viewerKey}:${profileId}` : undefined;
  const encounterKey = encounterId ? `${viewerKey}:${encounterId}` : undefined;
  const detailScope = useRef({ profileKey, encounterKey, profileRequest: 0, encounterRequest: 0 });
  if (detailScope.current.profileKey !== profileKey) {
    detailScope.current.profileKey = profileKey;
    detailScope.current.profileRequest++;
  }
  if (detailScope.current.encounterKey !== encounterKey) {
    detailScope.current.encounterKey = encounterKey;
    detailScope.current.encounterRequest++;
  }
  const profile: LoadState<CompanionProfile> = profileResult && profileResult.key === profileKey
    ? profileResult.state : { kind: "idle" };
  const encounter: LoadState<EncounterDetail> = encounterResult && encounterResult.key === encounterKey
    ? encounterResult.state : { kind: "idle" };


  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let active = true;
    void loadIdentityOwner(() => active);
    return () => {
      active = false;
      ownerCompanionsRequest.current++;
      cache.purgeViewerSensitive();
    };
  }, [client]);

  useEffect(() => {
    if (identity.kind !== "success") return;
    if (route.type === "root" && route.tab === "world" && !client.api.community) void loadWorld();
    if (route.type === "life-archive") void loadLife();
    if (profileId) void loadProfile(profileId);
    if (route.type === "encounter") void loadEncounter(route.encounterId);
  }, [
    route.type,
    route.type === "root" ? route.tab : "",
    route.type === "encounter" ? route.encounterId : "",
    profileId,
    viewerKey,
    client.api.community,
    cache.epoch,
  ]);

  function invalidateCompanionViews() {
    cache.purgeViewerSensitive();
    setProfileResult(undefined);
  }

  async function savePresetAvatar(companionId: string | null, avatar: string | null) {
    const save = client.api.chat?.saveAvatar;
    if (!ownerId || !save) throw new Error("Avatar settings unavailable.");
    const confirmed = await save(companionId, avatar);
    if (confirmed.avatar !== avatar) throw new Error("Avatar change was not confirmed.");
    if (companionId === null) {
      ownerProfileRequest.current++;
      setOwnerProfile(previous => ({ id: ownerId, name: previous?.id === ownerId ? previous.name : undefined, avatar: confirmed.avatar }));
      reloadOwnerProfile(value => value + 1);
    } else {
      setOwnerCompanions(previous => previous.kind === "success" ? {
        kind: "success",
        value: { items: previous.value.items.map(item => item.companionId === companionId ? { ...item, avatar: confirmed.avatar } : item) },
      } : previous);
      void loadOwnerCompanions(true);
    }
    invalidateCommunity();
  }

  async function deleteOwnedCompanion(companionId: string) {
    const remove = client.api.chat?.deleteCompanion;
    if (!ownerId || !remove) return;
    let roster: OwnerCompanionCollection | undefined;
    try {
      const result = await remove(companionId);
      if (result.deleted !== true) throw new Error("Companion removal was not confirmed.");
    } catch (error) {
      if (!(error instanceof ApiProblemError) || error.status !== 404) throw error;
      // A prior delete can succeed even when its response was lost. Confirm absence under this owner.
      roster = await client.api.ownerCompanions();
      if (roster.items.some(item => item.companionId === companionId)) throw error;
    }
    setOwnerCompanions(previous => {
      const items = (roster?.items ?? (previous.kind === "success" ? previous.value.items : []))
        .filter(item => item.companionId !== companionId);
      return items.length ? { kind: "success", value: { items } } : { kind: "empty" };
    });
    setCreatedHome(previous => previous?.companionId === companionId ? undefined : previous);
    invalidateCompanionViews();
    invalidateCommunity();
    refreshBadges();
    setCompanionDeleteRevision(value => value + 1);
    setNav(current => {
      if (current.stack.at(-1) === route) return selectTab(current, "home");
      const stack = current.stack.filter(item => item.type === "community-target"
        ? !(item.target.type === "profile" && item.target.companionId === companionId)
        : !("companionId" in item && item.companionId === companionId));
      return stack.length === current.stack.length ? current : { ...current, stack };
    });
    if (roster) ownerCompanionsRequest.current++;
    else void loadOwnerCompanions(true);
    void AsyncStorage.removeItem(`companion:import-review:v1:${ownerId}:${companionId}`).catch(() => undefined);
  }

  async function loadIdentityOwner(current: () => boolean) {
    setIdentity({ kind: "loading" });
    try {
      const value = await client.api.identityContext();
      if (!current()) return;
      setIdentity({ kind: "success", value });
      void loadOwnerCompanions();
      if (client.sample_companionCompanionId) {
        try {
          const ownCompanion = await client.api.companionProfile(
            client.sample_companionCompanionId,
          );
          if (current()) setCompanionDisplayName(ownCompanion.displayName);
        } catch {
          // The Stage 1 shell can still operate without a resolved display name.
        }
      }
    } catch (error) {
      const safe = safeClientMessage(error);
      if (current()) setIdentity({ kind: "error", ...safe });
    }
  }

  async function loadOwnerCompanions(keepCurrentOnFailure = false) {
    const request = ++ownerCompanionsRequest.current;
    if (!keepCurrentOnFailure) setOwnerCompanions(previous => previous.kind === "success" ? previous : { kind: "loading" });
    try {
      const value = await client.api.ownerCompanions();
      if (request !== ownerCompanionsRequest.current) return;
      setOwnerCompanions(value.items.length ? { kind: "success", value } : { kind: "empty" });
    } catch (error) {
      const safe = safeClientMessage(error);
      if (!keepCurrentOnFailure && request === ownerCompanionsRequest.current) setOwnerCompanions({ kind: "error", ...safe });
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
    // Life responses are already scoped to the requested identity, including Social Twins.
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
    const resultKey = `${viewerKey}:${id}`;
    if (detailScope.current.encounterKey !== resultKey) return;
    const version = ++detailScope.current.encounterRequest;
    const current = () => epoch === cache.epoch && detailScope.current.encounterKey === resultKey
      && detailScope.current.encounterRequest === version;
    const save = (state: LoadState<EncounterDetail>) => setEncounterResult({ key: resultKey, state });
    save({ kind: "loading" });
    try {
      const key = `encounter:${id}`;
      const value =
        cache.get<EncounterDetail>(key) ?? (await client.api.encounterDetail(id));
      if (!current()) return;
      cache.set(key, value);
      save({ kind: "success", value });
    } catch (error) {
      if (!current()) return;
      const safe = safeClientMessage(error);
      save({ kind: "error", ...safe });
    }
  }

  async function loadProfile(id: string) {
    const epoch = cache.epoch;
    const resultKey = `${viewerKey}:${id}`;
    if (detailScope.current.profileKey !== resultKey) return;
    const version = ++detailScope.current.profileRequest;
    const current = () => epoch === cache.epoch && detailScope.current.profileKey === resultKey
      && detailScope.current.profileRequest === version;
    const save = (state: LoadState<CompanionProfile>) => setProfileResult({ key: resultKey, state });
    save({ kind: "loading" });
    try {
      const viewer =
        identityValue && identityValue.activeSubject.kind !== "OWNER"
          ? { kind: identityValue.activeSubject.kind, id: identityValue.activeSubject.id }
          : undefined;
      const viewerKey = viewer ? `${viewer.kind}:${viewer.id}` : "OWNER";
      const key = `profile:${viewerKey}:${id}`;
      const value =
        cache.get<CompanionProfile>(key) ?? (await client.api.companionProfile(id, viewer));
      if (!current()) return;
      cache.set(key, value);
      save({ kind: "success", value });
    } catch (error) {
      if (!current()) return;
      const safe = safeClientMessage(error);
      save({ kind: "error", ...safe });
    }
  }

  async function switchIdentity(target:
    | { kind: "OWNER" }
    | { kind: "COMPANION"; id: string; displayName: string }
  ) {
    const previousIdentity = identityValue;
    const previousName = companionDisplayName;

    setSwitcherOpen(false);
    if (target.kind !== "OWNER" && (route.type === "chat" || route.type === "chat-settings" || route.type === "diary" || route.type === "album")) {
      setNav((current) => selectTab(current, current.rootTab));
    }
    setIdentitySwitchPending(true);
    setIdentity({ kind: "loading" });
    setWorld({ kind: "idle" });
    setLife({ kind: "idle" });
    setEncounterResult(undefined);
    setProfileResult(undefined);
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

  function openProfile(companionId: string, chatId?: string) {
    if (!ownerId && client.api.community && activeCompanion?.companionId === companionId) {
      openCommunity({ type: "profile" });
      return;
    }
    openCommunity({ type: "profile", companionId, ...(chatId ? { chatId } : {}) });
  }

  function companionProfileActions(item: OwnerCompanionSummary): ManagedProfileActions {
    const companionId = item.companionId;
    const chatId = profileTarget?.companionId === companionId ? profileTarget.chatId : undefined;
    const open = (next: Route) => setNav(current => pushRoute(current, next));
    const onCommunitySettings = () => {
      if (item.socialReady) {
        open({ type: "controls", companionId });
      } else {
        open({
          type: "social-activation", companionId, identityId: item.identityId,
          displayName: item.displayName, approvedFields: item.approvedFields,
        });
      }
    };
    const menu: ManagedProfileActions["menu"] = [];
    if (client.api.chat?.getPersona && client.api.chat.savePersona) {
      menu.push({ label: "编辑人设／资料", onPress: () => open({ type: "chat-settings", companionId, focusPersona: true }) });
    }
    if (client.api.chat?.saveAvatar) {
      menu.push({ label: "更换头像", onPress: () => open({ type: "avatar-settings", companionId }) });
    }
    if (canUseChat) {
      menu.push({ label: "聊天设置", onPress: () => open({ type: "chat-settings", companionId, chatId }) });
    }
    menu.push({ label: "社区公开设置", onPress: onCommunitySettings });
    if (item.socialReady && client.api.community) {
      menu.push({ label: "家机活动设置", onPress: () => open({ type: "agent-settings", companionId }) });
    }
    menu.push({ label: "更新导入资料", onPress: () => open({ type: "bring-companion", companionId }) });

    return {
      onChat: canUseChat ? () => {
        const previous = nav.stack.at(-2);
        if (previous?.type === "chat" && (previous.companionId === companionId
          || (chatId && previous.chatId === chatId))) {
          goBack();
          return;
        }
        open({ type: "chat", companionId, companionName: item.displayName, chatId, fromTab: nav.rootTab });
      } : undefined,
      onHome: () => {
        selectHomeCompanion(companionId);
        setNav(current => selectTab(current, "home"));
      },
      onCommunitySettings,
      menu,
    };
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

  useEffect(() => {
    if (route.type === "root" || route.type === "compose-post" || route.type === "bring-companion" || route.type === "bring-connection" || route.type === "chat-settings") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [route, nav, identityId, reducedMotion]);

  function openCommunity(target: CommunityTarget) {
    setNav(current => pushRoute(current, { type: "community-target", target }));
  }

  function openFollows(direction: FollowDirection) {
    setNav(current => pushRoute(current, { type: "community-follows", direction }));
  }

  function openFromTab(tab: RootTab, next: Route) {
    setNav(current => {
      const top = current.stack.at(-1);
      return top?.type === "root" && top.tab === tab ? pushRoute(current, next) : current;
    });
  }

  function openDiary(companionId: string) {
    if (!diaryClient || !homeCompanion || companionId !== homeCompanion.companionId) return;
    openFromTab("home", { type: "diary", companionId, companionName: homeCompanion.displayName });
  }

  const messagesVisible = route.type === "root" && route.tab === "messages";
  const isMoment = route.type === "encounter" && momentMode && encounter.kind === "success";
  const currentKind = identityValue?.activeSubject.kind ?? "OWNER";
  const isSampleCompanion = currentKind !== "OWNER";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: skin.colors.canvas }]}>
      <StatusBar style={skin.isDark ? "light" : "dark"} />
      {(route.type === "root" || route.type === "bring-companion") && (
        <LinearGradient pointerEvents="none" colors={ui.background} style={StyleSheet.absoluteFill} />
      )}

      {!isMoment && route.type !== "chat" && route.type !== "chat-settings" && route.type !== "compose-post" && route.type !== "bring-companion" && route.type !== "bring-connection" && (
        <AppHeader
          routeIsRoot={route.type === "root"}
          rootTab={nav.rootTab}
          identityTitle={identityLabel(identityValue, ownerNickname)}
          isSampleCompanion={isSampleCompanion}
          avatar={activeAvatar}
          identityLoading={identity.kind === "loading"}
          onBack={goBack}
          onIdentity={() => setSwitcherOpen(true)}
          onOpenSettings={() => setNav(current => pushRoute(current, { type: "settings" }))}
        />
      )}

      {viewer && client.api.community && (
        <View pointerEvents={worldVisible ? "auto" : "none"} aria-hidden={!worldVisible}
          importantForAccessibility={worldVisible ? "auto" : "no-hide-descendants"}
          accessibilityElementsHidden={!worldVisible}
          style={worldVisible ? { flex: 1 } : styles.inactiveRoot}>
          <CommunityScreen key={viewerKey} client={client.api.community} viewer={viewer}
            onPublish={() => openFromTab("world", { type: "compose-post" })}
            onNavigate={openCommunity} onFollowList={openFollows} onBack={goBack}
            revision={communityRevision} onChanged={invalidateCommunity}
            initialScrollY={nav.scrollByIdentityAndTab[scrollKey(identityId, "world")] ?? 0}
            onScroll={y => setNav(current => saveScroll(current, identityId, "world", y))} />
        </View>
      )}
      {worldVisible && !client.api.community && <WorldScreen
        state={world} isMockMode={isMockMode} scrollRef={worldScrollRef}
        onScroll={y => setNav(current => saveScroll(current, identityId, "world", y))}
        onOpenActor={openProfile} onOpenEncounter={openEncounter} onRetry={() => void loadWorld()} />}

      <View
        pointerEvents={route.type === "root" && route.tab === "home" ? "auto" : "none"}
        aria-hidden={route.type !== "root" || route.tab !== "home"}
        accessibilityElementsHidden={route.type !== "root" || route.tab !== "home"}
        importantForAccessibility={route.type === "root" && route.tab === "home" ? "auto" : "no-hide-descendants"}
        style={
          route.type === "root" && route.tab === "home"
            ? { flex: 1 }
            : { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0, zIndex: -1 }
        }
      >
        {!isMockMode && ownerId && ownerCompanions.kind === "empty" && !homeScope ? (
          <View style={styles.center}>
            <Text style={styles.centerTitle}>小家还没有家机</Text>
            <CommunityButton label="接入家机" primary
              onPress={() => setNav(current => pushRoute(current, { type: "bring-companion" }))} />
          </View>
        ) : <PrivateHomeScreen
          key={JSON.stringify([viewerKey, homeScope?.ownerId, homeCompanion?.companionId])}
          chatClient={canUseChat ? client.api.chat : undefined}
          scope={homeScope}
          isCompanion={isSampleCompanion}
          isActive={route.type === "root" && route.tab === "home"}
          companionName={homeCompanion?.displayName ?? companionDisplayName}
          companionAvatar={homeCompanion?.avatar ?? activeCompanion?.avatar}
          companions={availableCompanions}
          onSelectCompanion={selectHomeCompanion}
          onOpenProfile={homeCompanion ? () => openProfile(homeCompanion.companionId)
            : activeCompanion ? () => openProfile(activeCompanion.companionId) : undefined}
          onOpenDiary={diaryClient && homeScope ? () => openDiary(homeScope.companionId) : undefined}
          onOpenAlbum={homeScope ? () => openFromTab("home", { type: "album", companionId: homeScope.companionId }) : undefined}
        />}
      </View>

      {viewer && (
        <View
          pointerEvents={messagesVisible ? "auto" : "none"}
          aria-hidden={!messagesVisible}
          accessibilityElementsHidden={!messagesVisible}
          importantForAccessibility={messagesVisible ? "auto" : "no-hide-descendants"}
          style={messagesVisible ? { flex: 1 } : styles.inactiveRoot}
        >
          <MessagesScreen
            key={JSON.stringify([viewerKey, companionDeleteRevision])}
            api={client.api}
            viewer={viewer}
            chatClient={canUseChat ? client.api.chat : undefined}
            ownerId={ownerId}
            draftStore={canUseChat ? chatDrafts : undefined}
            companions={ownerCompanions.kind === "success" ? ownerCompanions.value.items : []}
            visible={messagesVisible}
            onChat={chat => openFromTab("messages", {
              type: "chat", chatId: chat.id, companionId: chat.direct ? chat.members[0]?.companionId : undefined,
              companionName: chat.title ?? chat.members.map(member => member.displayName).join("、"),
              fromTab: "messages",
            })}
            onStartChat={companion => openFromTab("messages", {
              type: "chat", companionId: companion.companionId, companionName: companion.displayName, fromTab: "messages",
            })}
            onOpenCompanionProfile={openProfile}
            onCreateGroup={groupCreateEnabled ? () => openFromTab("messages", { type: "create-group" }) : undefined}
            onCommunityTarget={target => openFromTab("messages", { type: "community-target", target })}
            onRead={refreshBadges}
            onLife={item => item.kind === "AGENT_DRAFT" || item.linkedObject?.type === "AGENT_DRAFT"
              ? openFromTab("messages", { type: "agent-drafts", companionId: item.companionId, draftId: item.linkedObject?.id })
              : openFromTab("messages", { type: "life-archive" })}
          />
        </View>
      )}

      {route.type === "community-target" && viewer && (client.api.community || profileTarget?.companionId) && (
        <CommunityScreen key={JSON.stringify([viewerKey, route.target])} client={client.api.community}
          viewer={viewer} initialTarget={route.target} onNavigate={openCommunity} onFollowList={openFollows}
          ownedCompanion={managedCompanion} ownedCompanions={ownerId ? availableCompanions : undefined}
          getManagedActions={ownerId ? companionProfileActions : undefined}
          legacyProfile={profileTarget?.companionId && profile.kind === "success" ? profile.value : undefined}
          legacyProfileError={profileTarget?.companionId && profile.kind === "error" ? profile.title : undefined}
          onRetryLegacyProfile={profileId && profile.kind === "error" && profile.retry ? () => void loadProfile(profileId) : undefined}
          onBack={goBack} revision={communityRevision} onChanged={invalidateCommunity} onScroll={() => {}} />
      )}

      {route.type === "compose-post" && viewer && identityValue && client.api.community && (
        <ComposePostScreen key={viewerKey} client={client.api.community} viewer={viewer}
          ownerId={identityValue.viewer.ownerId} onBack={goBack} onPublished={() => {
            setCommunityRevision(value => value + 1);
            goBack();
          }} />
      )}

      {route.type === "community-follows" && viewer && client.api.community && (
        <CommunityFollowList client={client.api.community} viewer={viewer} direction={route.direction}
          onActor={id => openCommunity({ type: "profile", id })}
          onChanged={invalidateCommunity} />
      )}

      {route.type === "feedback" && ownerId && client.api.chat?.listFeedback && (
        <FeedbackScreen client={client.api.chat} onRead={refreshBadges} />
      )}

      {route.type === "album" && homeScope && route.companionId === homeScope.companionId && (
        <AlbumScreen key={JSON.stringify(homeScope)} scope={homeScope} />
      )}

      {route.type === "create-group" && canUseChat && client.api.chat && (
        <CreateGroupScreen client={client.api.chat} companions={availableCompanions}
          enabled={groupCreateEnabled} onAvailabilityChanged={refreshFeatures} onCreated={chat => {
          setNav(current => current.stack.at(-1) === route
            ? pushRoute(popRoute(current), { type: "chat", chatId: chat.id, companionName: chat.title ?? "群聊", fromTab: "messages" })
            : current);
        }} />
      )}

      {route.type === "chat-settings" && canUseChat && client.api.chat && (
        <ChatSettingsScreen key={JSON.stringify([viewerKey, route.companionId, route.chatId])} client={client.api.chat} companionId={route.companionId} companions={availableCompanions} chatId={route.chatId} ownerId={ownerId} connectionKind={route.connectionKind} connectionsEnabled={connectionsEnabled} groupSendEnabled={groupSendEnabled}
          focusPersona={route.focusPersona} onAvailabilityChanged={refreshFeatures} onBack={goBack}
          onConversationDeleted={route.chatId ? () => {
            refreshBadges();
            setNav(current => {
              if (current.stack.at(-1) !== route) return current;
              const parent = popRoute(current);
              return parent.stack.at(-1)?.type === "chat" ? popRoute(parent) : parent;
            });
          } : undefined}
          onDeleteCompanion={route.companionId && client.api.chat.deleteCompanion
            ? () => deleteOwnedCompanion(route.companionId!) : undefined} />
      )}

      {route.type === "chat" && canUseChat && client.api.chat && (
        <ChatScreen
          key={JSON.stringify([viewerKey, route.chatId, route.companionId])}
          client={client.api.chat}
          draftStore={chatDrafts}
          initialChatId={route.chatId}
          companionId={route.companionId}
          companionName={route.companionName ?? companionDisplayName}
          ownerName={identityLabel(identityValue, ownerNickname)}
          ownerAvatar={ownerAvatar}
          ownerId={ownerId!}
          autoFocus={route.autoFocus === true}
          backLabel={route.fromTab === "messages" ? "返回消息" : route.fromTab === "my" ? "返回" : "返回小家"}
          onSaveQuote={ownerId && route.companionId ? quote => addAlbumQuote({ ownerId, companionId: route.companionId! }, quote) : undefined}
          onOpenSettings={(chatId, companionId) => setNav(current => pushRoute(current, { type: "chat-settings", chatId, companionId }))}
          onOpenProfile={(companionId, chatId) => {
            if (companionId) openProfile(companionId, chatId);
            else if (client.api.community) openCommunity({ type: "profile" });
          }}
          onRead={refreshBadges}
          groupSendEnabled={groupSendEnabled}
          onAvailabilityChanged={refreshFeatures}
          onBackToHome={goBack}
        />
      )}

      {route.type === "diary" && diaryClient && (
        <DiaryScreen key={`${viewerKey}:${route.companionId}`} client={diaryClient}
          companionId={route.companionId} companionName={route.companionName}
          companions={availableCompanions}
          onSelectCompanion={comp => {
            selectHomeCompanion(comp.companionId);
            setNav(current => current.stack.at(-1)?.type === "diary"
              ? pushRoute(popRoute(current), { type: "diary", companionId: comp.companionId, companionName: comp.displayName })
              : current);
          }} />
      )}

      {route.type === "life-archive" && (
        <LifeScreen
          state={life}
          isCompanion={isSampleCompanion}
          companionName={companionDisplayName}
          onRetry={() => void loadLife()}
          onOpenEncounter={openLifeEncounter}
        />
      )}

      {route.type === "root" && (
        <View
          pointerEvents={route.tab === "my" ? "auto" : "none"}
          aria-hidden={route.tab !== "my"}
          style={
            route.tab === "my"
              ? { flex: 1 }
              : { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0, zIndex: -2 }
          }
        >
        <MyScreen
          key={`${currentKind}:${identityId}`}
          community={client.api.community}
          identity={identity}
          isSampleCompanion={isSampleCompanion}
          companionName={companionDisplayName}
          companions={ownerCompanions}
          homeCompanionId={homeCompanion?.companionId}
          avatar={activeAvatar}
          selfProfile={profile}
          onAddCompanion={() => setNav(current => pushRoute(current, { type: "bring-companion" }))}
          onOpenCompanionProfile={item => openProfile(item.companionId)}
          onOpenCompanionChat={canUseChat ? item => setNav(current => pushRoute(current, {
            type: "chat", companionId: item.companionId, companionName: item.displayName, fromTab: "my",
          })) : undefined}
          onFollowList={openFollows}
          onPosts={id => openCommunity({ type: "profile", id })}
          onOpenPostDetail={id => openCommunity({ type: "detail", id })}
          feedbackUnread={feedbackUnread}
          onOpenFeedback={ownerId && client.api.chat?.listFeedback ? () => setNav(current => pushRoute(current, { type: "feedback" })) : undefined}
          onRefresh={() => {
            refreshBadges();
            if (authenticatedOwner) void loadOwnerCompanions(true);
          }}
          communityRevision={communityRevision}
          onEditHumanProfile={identityValue?.activeSubject.kind === "OWNER" && client.api.community
            ? () => setNav(current => pushRoute(current, { type: "edit-human-profile" })) : undefined}
        />
        </View>
      )}

      {route.type === "agent-settings" && settingsViewer && client.api.community && (
        <AgentSettingsScreen key={JSON.stringify([viewerKey, settingsViewer.kind, settingsViewer.id])}
          client={client.api.community} viewer={settingsViewer}
          onOpenDrafts={() => setNav(current => pushRoute(current, { type: "agent-drafts", companionId: route.companionId }))} />
      )}

      {route.type === "agent-drafts" && (agentViewer || (ownerId && route.companionId)) && client.api.community && (
        <AgentDraftsScreen key={route.companionId ?? agentViewer?.id} client={client.api.community}
          viewer={route.companionId ? { kind: "COMPANION", id: route.companionId } : agentViewer!}
          draftId={route.draftId} onChanged={refreshBadges} />
      )}

      {editingOwnerProfile && identityValue?.activeSubject.kind === "OWNER" && client.api.community && (
        <View style={route.type === "edit-human-profile" ? styles.rootContent : styles.inactiveRoot}
          pointerEvents={route.type === "edit-human-profile" ? "auto" : "none"}
          aria-hidden={route.type !== "edit-human-profile"} accessibilityElementsHidden={route.type !== "edit-human-profile"}
          importantForAccessibility={route.type === "edit-human-profile" ? "auto" : "no-hide-descendants"}>
          <HumanProfileEditor key={identityId} client={client.api.community}
            avatar={ownerAvatar} viewer={{ kind: "OWNER", id: identityId }}
            onChangeAvatar={client.api.chat?.saveAvatar ? () =>
              setNav(current => pushRoute(current, { type: "avatar-settings" })) : undefined}
            onClose={saved => {
              if (saved) { reloadOwnerProfile(value => value + 1); invalidateCommunity(); }
              goBack();
            }} />
        </View>
      )}

      {route.type === "avatar-settings" && ownerId && client.api.chat?.saveAvatar && (
        route.companionId && !avatarCompanion ? <Centered title="这位家机暂时不可用。" /> : (
          <PresetAvatarPicker key={JSON.stringify([ownerId, route.companionId])}
            current={avatarCompanion ? avatarCompanion.avatar : ownerAvatar}
            name={avatarCompanion?.displayName ?? identityLabel(identityValue, ownerNickname)}
            role={avatarCompanion ? "companion" : "owner"}
            onClose={() => setNav(current => current.stack.at(-1) === route ? popRoute(current) : current)}
            onSave={value => savePresetAvatar(route.companionId ?? null, value)} />
        )
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

      {route.type === "bring-companion" && viewer?.kind === "OWNER" && (
        <BringCompanionScreen
          key={route.companionId ?? "new"}
          onBack={goBack}
          api={client.api}
          existingCompanionId={route.companionId}
          ownerId={ownerId}
          companionCount={availableCompanions.length}
          canConfigureConnection={connectionsEnabled && Boolean(client.api.chat?.saveConnection)}
          onCreated={(created, approvedFields, connectionKind) => {
            setCreatedHome({
              companionId: created.companionId, displayName: created.displayName, identityId: created.id,
              identityVersion: created.version, approvedFields, status: "ACTIVE", socialReady: false,
            });
            invalidateCompanionViews();
            void loadOwnerCompanions();
            setNav(current => {
              const home = selectTab(current, "home");
              return connectionKind && client.api.chat?.saveConnection
                ? pushRoute(home, { type: "bring-connection", companionId: created.companionId, kind: connectionKind })
                : home;
            });
          }}
        />
      )}

      {route.type === "bring-connection" && canUseChat && client.api.chat?.saveConnection && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: CHROME.screenInset, gap: 14 }}>
            <SecondaryHeading title={route.kind === "key" ? "自带 API Key" : "连接自建家机"} />
            <ConnectionForm kind={route.kind} onClose={goBack} handleBack closeLabel="稍后设置，先去小家" submitConnection={async input => {
              const result = await client.api.chat!.saveConnection!(route.companionId, input);
              if (result.result === "CONNECTED") setNav(current => current.stack.at(-1) === route ? popRoute(current) : current);
              return result;
            }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {route.type === "social-activation" && ownerId && (
        <SocialActivationScreen
          api={client.api}
          companion={route}
          onActivated={({ persona, twin }) => {
            const apply = (item: OwnerCompanionSummary) => item.companionId === route.companionId
              ? { ...item, socialReady: true, handle: persona.handle, socialTwinId: twin.id }
              : item;
            setOwnerCompanions(previous => previous.kind === "success" ? {
              kind: "success", value: { items: previous.value.items.map(apply) },
            } : previous);
            setCreatedHome(previous => previous && apply(previous));
            invalidateCompanionViews();
            invalidateCommunity();
            void loadOwnerCompanions(true);
            setNav(current => current.stack.at(-1) === route ? popRoute(current) : current);
          }}
        />
      )}

      {route.type === "controls" && (
        <ControlsScreen
          api={client.api}
          companionId={route.companionId}
          companionName={availableCompanions.find(item => item.companionId === route.companionId)?.displayName ?? companionDisplayName}
          onVisibilitySaved={() => {
            invalidateCompanionViews();
            invalidateCommunity();
          }}
          diaryClient={diaryClient}
          onChatSettings={canUseChat ? () => setNav(current => pushRoute(current, { type: "chat-settings", companionId: route.companionId })) : undefined}
        />
      )}

      {!isMoment && route.type === "root" && (
        <FloatingGlassTabs
          current={nav.rootTab}
          unread={unread}
          myBadge={feedbackUnread}
          onSelect={(tab) => setNav((state) => selectTab(state, tab))}
        />
      )}

      <IdentitySwitcher
        visible={switcherOpen}
        identity={identity}
        ownerNickname={ownerNickname}
        ownerAvatar={ownerAvatar}
        companions={ownerCompanions}
        pending={identitySwitchPending}
        onClose={() => setSwitcherOpen(false)}
        onOwner={() => void switchIdentity({ kind: "OWNER" })}
        onCompanion={(item) => void switchCompanionFromUi(item)}
      />

      {route.type === "settings" && (
        <SettingsScreen
          account={account}
          ownerName={identityLabel(identityValue, ownerNickname)}
          avatar={activeAvatar}
          isCompanion={isSampleCompanion}
          walletClient={ownerId ? client.api.chat : undefined}
          onSwitchIdentity={() => setSwitcherOpen(true)}
          onBlocks={viewer && client.api.community ? () => openCommunity({ type: "blocks" }) : undefined}
          onBringCompanion={isSampleCompanion
            ? undefined
            : () => setNav(current => pushRoute(current, { type: "bring-companion" }))}
          onAgentSettings={agentViewer && client.api.community
            ? () => setNav(current => pushRoute(current, { type: "agent-settings" }))
            : undefined}
          onOpenFeedback={ownerId && client.api.chat?.listFeedback
            ? () => setNav(current => pushRoute(current, { type: "feedback" }))
            : undefined}
          onOpenLegal={doc => setNav(current => pushRoute(current, { type: "legal", doc }))}
        />
      )}

      {route.type === "legal" && (
        <LegalScreen doc={route.doc} />
      )}
    </SafeAreaView>
  );
}

function AppHeader({
  routeIsRoot,
  rootTab,
  identityTitle,
  isSampleCompanion,
  avatar,
  identityLoading,
  onBack,
  onIdentity,
  onOpenSettings,
}: {
  routeIsRoot: boolean;
  rootTab: RootTab;
  identityTitle: string;
  isSampleCompanion: boolean;
  avatar?: string | null;
  identityLoading: boolean;
  onBack: () => void;
  onIdentity: () => void;
  onOpenSettings: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { skin, ui } = useSkin();
  const defaultSkin = skin.id === "default";
  const ink = defaultSkin ? ui.ink : skin.colors.ink;

  return (
    <View style={!routeIsRoot && { backgroundColor: ui.background[0] }}>
      <View style={styles.topBar}>
        {routeIsRoot ? (
          <Pressable
            style={({ pressed }) => [styles.identityTrigger, pressed && { opacity: 0.75 }]}
            onPress={onIdentity}
            accessibilityRole="button"
            accessibilityLabel="切换当前身份"
          >
            <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
            <PixelAvatar name={identityTitle} role={isSampleCompanion ? "companion" : "owner"} uri={avatar} size={28} />
            <Text style={[styles.brand, { color: ink }]} numberOfLines={1}>{identityTitle}</Text>

            <Text style={[styles.chevron, { color: skin.colors.inkMute }]}>⌄</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.headerIconBtn} onPress={onBack} accessibilityRole="button" accessibilityLabel="返回">
            <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
            <Ionicons name="chevron-back" size={19} color={ink} />
          </Pressable>
        )}

        <View style={styles.headerRight}>
          {routeIsRoot && (rootTab === "my" || rootTab === "home") && (
            <Pressable
              onPress={onOpenSettings}
              style={({ pressed }) => [styles.headerIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
              accessibilityRole="button"
              accessibilityLabel="打开设置"
            >
              <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
              <Ionicons name="settings-outline" size={19} color={ink} />
            </Pressable>
          )}
          {identityLoading && <ActivityIndicator size="small" />}
        </View>
      </View>

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
  const styles = useThemedStyles(createStyles);
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "empty") {
    return <Centered title="公共社区还没有可见内容" body="这里会展示真实发布或授权公开的社区记录。" />;
  }
  if (state.kind === "error") {
    return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;
  }
  if (state.kind !== "success") return <Centered title="公共社区暂时无法连接。" />;

  const items = state.value.items.filter(item => item.kind !== "ENCOUNTER_EXCERPT");

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.content}
      contentContainerStyle={styles.feed}
      onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={100}
    >
      <View style={styles.feedHeading}>
        <Text style={styles.feedTitle}>社区动态</Text>
      </View>

      {items.length === 0 && (
        <View style={styles.feedEnd}><Text style={styles.tinyMuted}>当前加载的记录里没有这一类内容。</Text></View>
      )}

      {items.map((item) => (
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
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const canOpen = item.viewerCapabilities.openDetail === true && item.source.type === "ENCOUNTER";
  const hasMedia = (item.media?.length ?? 0) > 0;

  return (
    <View style={styles.feedItem}>
      <Pressable style={styles.feedAuthorRow} disabled={!onOpenActor} onPress={onOpenActor}>
        <PixelAvatar
          name={item.author.displayName}
          role={item.author.subjectKind === "OWNER" ? "owner" : "companion"}
          size={38}
        />
        <View style={styles.feedAuthorText}>
          <View style={styles.feedAuthorLine}>
            <Text style={styles.feedAuthorName} numberOfLines={1}>{item.author.displayName}</Text>
          </View>
          <Text style={styles.feedMeta}>{formatDate(item.publishedAt)}</Text>
        </View>
        {item.viewerCapabilities.more === true && <Text style={styles.more}>•••</Text>}
      </Pressable>

      {item.body && (
        <Text style={styles.feedBody}>
          {item.body.split(/(#[^\s#]+)/g).map((seg, i) =>
            seg.startsWith("#") ? (
              <Text key={i} style={{ color: ui.accent, fontWeight: "600" }}>{seg}</Text>
            ) : (
              <Text key={i}>{seg}</Text>
            ),
          )}
        </Text>
      )}

      {item.completeness === "PARTIAL" && (
        <View style={styles.inlineNotice}>
          <Text style={styles.inlineNoticeText}>有一部分没回来。</Text>
        </View>
      )}

      {hasMedia ? (
        <View style={styles.mediaStack}>
          {item.media!.map((media, index) => {
            if (isMockMode && media.type === "LOCAL_PREVIEW_IMAGE" && typeof media.key === "string" && LOCAL_PREVIEW_IMAGES[media.key]) {
              return <Image key={index} source={LOCAL_PREVIEW_IMAGES[media.key]} resizeMode="cover" style={styles.feedMediaImage} />;
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

      {canOpen && (
        <View style={styles.feedActions}>
          <Pressable onPress={onOpen}>
            <Text style={styles.accentLink}>查看详情 →</Text>
          </Pressable>
        </View>
      )}
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
  const styles = useThemedStyles(createStyles);
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
        <PixelAvatar name={displayName} role="companion" uri={avatar} size={46} />
        <Text style={styles.participantName} numberOfLines={2} ellipsizeMode="tail">{displayName}</Text>
        {participant?.presentationAvailable === true && participant.handle && (
          <Text style={styles.participantHandle} numberOfLines={2} ellipsizeMode="tail">@{participant.handle}</Text>
        )}
      </Pressable>
    );
  };

  return (
    <ScrollView
      style={styles.secondaryPage}
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
            <SecondaryHeading title="相遇" />
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


function LifeScreen({
  state,
  isCompanion,
  companionName,
  onRetry,
  onOpenEncounter,
}: {
  state: LoadState<LifeContinuityCollection>;
  isCompanion: boolean;
  companionName: string;
  onRetry: () => void;
  onOpenEncounter: (item: LifeContinuityItem) => void;
}) {
  const styles = useThemedStyles(createStyles);
  if (state.kind === "loading" || state.kind === "idle") return <Loading />;
  if (state.kind === "error") return <ErrorState title={state.title} retry={state.retry} onRetry={onRetry} />;

  return (
    <ScrollView style={styles.secondaryPage} contentContainerStyle={styles.lifePage}>
      <SecondaryHeading title={isCompanion ? `${companionName} 的生活` : "生活"} />
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
  avatar,
  community,
  isSampleCompanion,
  companionName,
  companions,
  selfProfile,
  homeCompanionId,
  onAddCompanion,
  onOpenCompanionProfile,
  onOpenCompanionChat,
  onFollowList,
  onPosts,
  onOpenPostDetail,
  feedbackUnread = 0,
  onOpenFeedback,
  onRefresh,
  communityRevision,
  onEditHumanProfile,
}: {
  community?: CommunityClient;
  identity: LoadState<ActiveIdentityContext>;
  avatar?: string | null;
  isSampleCompanion: boolean;
  companionName: string;
  companions: LoadState<OwnerCompanionCollection>;
  selfProfile: LoadState<CompanionProfile>;
  homeCompanionId?: string;
  onAddCompanion: () => void;
  onOpenCompanionProfile: (item: OwnerCompanionSummary) => void;
  onOpenCompanionChat?: (item: OwnerCompanionSummary) => void;
  onFollowList: (direction: FollowDirection) => void;
  communityRevision: number;
  onPosts: (id: string) => void;
  onOpenPostDetail: (postId: string) => void;
  feedbackUnread?: number;
  onOpenFeedback?: () => void;
  onRefresh: () => void;
  onEditHumanProfile?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { skin, ui } = useSkin();

  const [communityData, setCommunityData] = useState<LoadState<CommunityPost[]>>({ kind: "idle" });
  const [ownProfile, setOwnProfile] = useState<CommunityProfile>();
  const [refreshing, setRefreshing] = useState(false);
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const subject = identity.kind === "success" ? identity.value.activeSubject : undefined;
  const actorKind = subject?.kind;
  const actorId = subject?.id;

  useEffect(() => {
    if (!community || !actorKind || !actorId) {
      setRefreshing(false);
      return;
    }
    const viewer = { kind: actorKind, id: actorId };
    let active = true;
    setCommunityData(previous => previous.kind === "success" ? previous : { kind: "loading" });
    void community.profile(viewer).then(async profile => {
      if (!active) return;
      setOwnProfile(profile);
      const feed = await community.feed(viewer, { authorId: profile.id });
      if (active) setCommunityData({ kind: "success", value: feed.items });
    }).catch(error => {
      if (active) setCommunityData({ kind: "error", ...safeClientMessage(error) });
    }).finally(() => {
      if (active) setRefreshing(false);
    });
    return () => { active = false; };
  }, [community, actorKind, actorId, communityRevision, manualRefreshTick]);
  const displayName = ownProfile?.displayName ?? subject?.presentation.displayName
    ?? (isSampleCompanion ? companionName : "我的账号");
  const bio = ownProfile?.bio;
  const defaultSkin = skin.id === "default";
  const ink = defaultSkin ? ui.ink : skin.colors.ink;
  const muted = defaultSkin ? ui.muted : skin.colors.inkSub;

  return (
    <ScrollView
      style={styles.rootContent}
      contentContainerStyle={[styles.mySocialPage, { paddingBottom: CHROME.scrollBottomClearance }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={ui.accentInk}
          colors={[ui.accentInk]}
          onRefresh={() => {
            setRefreshing(true);
            setManualRefreshTick(t => t + 1);
            onRefresh();
          }}
        />
      }
    >
      <UnifiedProfileView name={displayName} role={isSampleCompanion ? "companion" : "owner"}
        avatar={avatar === undefined ? ownProfile?.avatar : avatar} bio={bio}
        subtitle={ownProfile ? `@${ownProfile.handle}`
          : isSampleCompanion && selfProfile.kind === "success" ? `@${selfProfile.value.handle}` : undefined}
        stats={ownProfile} onFollowList={onFollowList}>
        {onEditHumanProfile && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="编辑资料"
            onPress={onEditHumanProfile}
            style={({ pressed }) => [styles.editProfilePill, pressed && { transform: [{ scale: 0.95 }] }]}
          >
            <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
            <Ionicons name="create-outline" size={14} color={ui.accentInk} />
            <Text style={styles.editProfilePillText}>编辑资料</Text>
          </Pressable>
        )}
      </UnifiedProfileView>

      {!isSampleCompanion && (companions.kind === "success" || companions.kind === "empty") && (
        <View style={{ gap: 8 }}>
          <View style={styles.postSectionHeader}>
            <Text style={[styles.privateHomeSectionTitle, { color: ink }]}>我的家机 ({companions.kind === "success" ? companions.value.items.length : 0})</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 2 }}>
            {companions.kind === "success" && companions.value.items.map(item => (
              <View
                key={item.companionId}
                style={{
                  width: 148,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: skin.colors.border,
                  backgroundColor: defaultSkin ? ui.white : skin.colors.surface,
                  padding: 12,
                  gap: 8,
                }}
              >
                <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${item.displayName} 的主页`}
                  onPress={() => onOpenCompanionProfile(item)} style={styles.myCompanionIdentity}>
                  <PixelAvatar name={item.displayName} role="companion" uri={item.avatar} size={38} />
                  <Text style={[styles.relTitle, { color: ink }]} numberOfLines={1}>{item.displayName}</Text>
                  <Text style={[styles.relSub, { color: muted }]} numberOfLines={1}>
                    {item.companionId === homeCompanionId ? "● 正在小家" : "主页"}
                  </Text>
                </Pressable>
                {onOpenCompanionChat && (
                  <Pressable accessibilityRole="button" onPress={() => onOpenCompanionChat(item)}
                    style={[styles.relControlBtn, { alignItems: "center", backgroundColor: ui.iceBlue, borderColor: ui.highlight }]}>
                    <Text style={[styles.relControlText, { color: ui.accentInk }]}>聊天</Text>
                  </Pressable>
                )}
              </View>
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="添加家机" onPress={onAddCompanion}
              style={styles.addCompanionCard}>
              <Ionicons name="add" size={22} color={ui.accentInk} />
              <Text style={[styles.heroBio, { color: ui.accentInk }]}>添加</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}


      <View style={styles.postSectionHeader}>
        <Text style={[styles.privateHomeSectionTitle, { color: ink }]}>最近动态</Text>
        {ownProfile && <Pressable accessibilityRole="button" onPress={() => onPosts(ownProfile.id)}>
          <Text style={[styles.heroBio, { color: ui.accentInk }]}>查看全部动态</Text>
        </Pressable>}
      </View>
      {communityData.kind === "loading" ? <ActivityIndicator /> : null}
      {communityData.kind === "error" ? <Text accessibilityRole="alert" style={[styles.heroBio, { color: muted }]}>{communityData.title}</Text> : null}
      {communityData.kind === "success" && communityData.value.length > 0 && (
        <View style={styles.privateHomeRecordList}>
          {communityData.value.slice(0, 3).map((post) => {
            const images = post.media?.filter(item => item.kind === "IMAGE") ?? [];
            const firstImage = images[0];
            return (
              <Pressable
                key={post.id}
                accessibilityRole="button"
                onPress={() => onOpenPostDetail(post.id)}
                style={({ pressed }) => [styles.privateHomeRecordRow, pressed && styles.myRowPressed]}
              >
                <View style={styles.privateHomeRecordText}>
                  <Text style={[styles.privateHomeRecordTitle, { color: ink }]} numberOfLines={3}>{post.body}</Text>
                  <Text style={[styles.privateHomeRecordCaption, { color: muted }]}>{formatDate(post.createdAt)}</Text>
                </View>
                {firstImage && (
                  <View style={styles.myThumbnail}>
                    <AuthPostImage
                      media={firstImage}
                      resolveMedia={community?.postMediaSource}
                      cacheScope={`${actorKind ?? ""}:${actorId ?? ""}:${communityRevision}`}
                      style={StyleSheet.absoluteFill}
                    />
                    {images.length > 1 && (
                      <Text style={styles.myThumbnailCount}>+{images.length - 1}</Text>
                    )}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
      {onOpenFeedback && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="意见反馈"
          accessibilityHint={feedbackUnread > 0 ? `${feedbackUnread} 条未读反馈` : undefined}
          onPress={onOpenFeedback}
          style={({ pressed }) => [styles.myFeedbackRow, pressed && styles.myRowPressed]}
        >
          <View style={styles.myFeedbackLabel}>
            <Ionicons name="chatbox-ellipses-outline" size={18} color={ui.accentInk} />
            <Text style={styles.myFeedbackTitle}>意见反馈</Text>
          </View>
          <View style={styles.myFeedbackLabel}>
            {feedbackUnread > 0 && (
              <Text style={styles.myFeedbackBadge}>{feedbackUnread > 99 ? "99+" : feedbackUnread}</Text>
            )}
            <Ionicons name="chevron-forward" size={16} color={muted} />
          </View>
        </Pressable>
      )}
      {(communityData.kind === "idle" || (communityData.kind === "success" && communityData.value.length === 0)) && (
        <View style={styles.privateHomeEmpty}>
          <Text style={[styles.privateHomeRecordCaption, { color: muted }]}>暂无动态</Text>
        </View>
      )}

    </ScrollView>
  );
}

function IdentitySwitcher({
  visible,
  identity,
  ownerNickname,
  ownerAvatar,
  companions,
  pending,
  onClose,
  onOwner,
  onCompanion,
}: {
  visible: boolean;
  identity: LoadState<ActiveIdentityContext>;
  ownerNickname?: string;
  ownerAvatar?: string | null;
  companions: LoadState<OwnerCompanionCollection>;
  pending: boolean;
  onClose: () => void;
  onOwner: () => void;
  onCompanion: (item: OwnerCompanionSummary) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const activeKind = identity.kind === "success" ? identity.value.activeSubject.kind : "OWNER";
  const activeId = identity.kind === "success" ? identity.value.activeSubject.id : undefined;
  const ownerActive = activeKind === "OWNER";
  const items = companions.kind === "success" ? companions.value.items : [];
  const ownerName = ownerNickname ?? identityLabel(ownerActive && identity.kind === "success" ? identity.value : undefined);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <LiquidGlassSurface glass borderRadius={16} style={styles.sheetHeading}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>切换身份</Text>
          </LiquidGlassSurface>
          <Text style={styles.sheetLabel}>现在是</Text>

          <Pressable style={styles.switchAccountRow} onPress={onOwner} disabled={pending}>
            <PixelAvatar name={ownerName} role="owner" uri={ownerAvatar} size={42} />
            <View style={styles.switchAccountText}>
              <Text style={styles.switchAccountName}>{ownerName}</Text>
            </View>
            <Text style={styles.checkmark}>{ownerActive ? "●" : "○"}</Text>
          </Pressable>

          <Text style={styles.sheetLabel}>切换成员</Text>

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
                <PixelAvatar name={item.displayName} role="companion" uri={item.avatar} size={42} />
                <View style={styles.switchAccountText}>
                  <Text style={styles.switchAccountName}>{item.displayName}</Text>
                  {!item.socialReady && (
                    <Text style={styles.accountHandle}>还没出门</Text>
                  )}
                </View>
                <Text style={styles.checkmark}>{active ? "●" : "○"}</Text>
              </Pressable>
            );
          })}

        </View>
      </View>
    </Modal>
  );
}

function Loading() {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.center}>
      <ActivityIndicator />
      <Text style={styles.tinyMuted}>稍等。</Text>
    </View>
  );
}

function Centered({ title, body }: { title: string; body?: string }) {
  const styles = useThemedStyles(createStyles);
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
  const styles = useThemedStyles(createStyles);
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

const createStyles = (ui: UiPalette) => StyleSheet.create({
  postSectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  safe: { flex: 1, backgroundColor: ui.background[0] },
  content: { flex: 1, backgroundColor: ui.background[0] },

  rootContent: { flex: 1 },
  inactiveRoot: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0, zIndex: -1 },
  topBar: {
    minHeight: 58,
    paddingHorizontal: CHROME.screenInset,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  identityTrigger: {
    minWidth: 0,
    minHeight: 44,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginRight: 12,
    paddingHorizontal: 9,
  },
  brand: { flexShrink: 1, fontSize: 14, fontWeight: "700", color: ui.ink, letterSpacing: -0.2 },
  chevron: { color: ui.placeholder, fontSize: 15, marginTop: -3 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
  privateHomeSectionTitle: { marginTop: 28, fontSize: 18, fontWeight: "700", color: ui.ink },
  privateHomeRecordList: { marginTop: 12, gap: 9 },
  privateHomeEmpty: { minHeight: 74, marginTop: 10, paddingHorizontal: 16, backgroundColor: ui.white, borderWidth: 1, borderColor: ui.highlight, borderRadius: 20, alignItems: "center", justifyContent: "center", gap: 8 },
  privateHomeRecordRow: { minHeight: 70, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: ui.white, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, borderRadius: 20, flexDirection: "row", alignItems: "center", gap: 12, shadowColor: ui.shadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 1 },
  myRowPressed: { opacity: 0.8 },
  myThumbnail: { width: 56, height: 56, overflow: "hidden", borderRadius: RADIUS.bubbleTail, backgroundColor: ui.accentWash },
  myThumbnailCount: { position: "absolute", right: 4, bottom: 4, overflow: "hidden", backgroundColor: ui.accent,
    color: ui.onAccent, borderRadius: RADIUS.pill, paddingHorizontal: 5, paddingVertical: 1, fontSize: 10, fontWeight: "700" },
  myFeedbackRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14,
    borderRadius: RADIUS.bubble, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, backgroundColor: ui.white },
  myFeedbackLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  myFeedbackTitle: { color: ui.ink, fontSize: 15, fontWeight: "600" },
  myFeedbackBadge: { color: ui.white, backgroundColor: ui.danger, overflow: "hidden", borderRadius: RADIUS.pill,
    paddingHorizontal: 6, paddingVertical: 2, fontSize: 11, fontWeight: "700" },

  privateHomeRecordText: { flex: 1 },
  privateHomeRecordTitle: { fontSize: 14, fontWeight: "600", color: ui.ink },
  privateHomeRecordCaption: { marginTop: 5, fontSize: 11, color: ui.muted },

  feed: { paddingBottom: 26 },
  feedHeading: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  feedTitle: { fontSize: 26, lineHeight: 32, fontWeight: "700", color: ui.ink, letterSpacing: -0.6 },
  feedItem: {
    backgroundColor: ui.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: ui.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 1,
  },
  feedAuthorRow: { flexDirection: "row", alignItems: "center" },
  feedAuthorText: { flex: 1, marginLeft: 10 },
  feedAuthorLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  feedAuthorName: { fontSize: 14, fontWeight: "600", color: ui.ink },
  feedMeta: { marginTop: 2, fontSize: 11, color: ui.placeholder },
  more: { fontSize: 15, color: ui.placeholder, letterSpacing: 1.5 },
  feedBody: { marginTop: 12, fontSize: 15, lineHeight: 22, color: ui.ink },
  mediaStack: { gap: 8, marginTop: 4 },
  feedMediaImage: { width: "100%", height: 196, borderRadius: 16, backgroundColor: ui.accentWash },
  mediaUnavailable: { minHeight: 120, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: ui.background[0], gap: 6, padding: 16 },
  noMedia: {
    height: 150,
    marginTop: 13,
    borderRadius: 16,
    backgroundColor: ui.background[0],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
    alignItems: "center",
    justifyContent: "center",
  },
  noMediaGlyph: { fontSize: 30, color: ui.placeholder },
  noMediaText: { marginTop: 4, fontSize: 12, color: ui.placeholder },
  feedActions: { marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  accentLink: { fontSize: 12, fontWeight: "600", color: ui.accentInk },
  feedEnd: { padding: 24, alignItems: "center" },

  encounterPage: { padding: 18, paddingBottom: 44 },
  encounterHero: { paddingVertical: 14, alignItems: "center" },
  encounterKicker: { fontSize: 10, letterSpacing: 1.2, color: ui.accentInk, fontWeight: "700" },
  encounterMeta: { marginTop: 6, fontSize: 12, color: ui.placeholder },
  participantRail: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  participant: { flex: 1, minWidth: 0, alignItems: "center" },
  participantName: { marginTop: 6, fontSize: 11, lineHeight: 15, textAlign: "center", color: ui.muted },
  participantHandle: { marginTop: 3, fontSize: 10, lineHeight: 14, textAlign: "center", color: ui.placeholder },
  connectionLine: { width: 18, height: StyleSheet.hairlineWidth, backgroundColor: ui.line },
  encounterBadge: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: ui.iceBlue,
  },
  encounterBadgeText: { fontSize: 10, color: ui.accentInk, fontWeight: "600" },
  encounterPanel: {
    marginTop: 24,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
  },
  sectionLabel: { fontSize: 10, letterSpacing: 1.1, color: ui.placeholder, fontWeight: "600" },
  encounterStatus: { marginTop: 8, fontSize: 22, fontWeight: "700", color: ui.ink },
  bodyText: { marginTop: 10, fontSize: 15, lineHeight: 23, color: ui.ink },
  warning: { marginTop: 10, fontSize: 12, color: ui.warning },
  actionStack: { marginTop: 22, gap: 10 },
  secondaryPill: {
    minHeight: 42,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryPillText: { color: ui.ink, fontSize: 13, fontWeight: "600" },
  traceBlock: { marginTop: 26, gap: 6 },

  moment: { flexGrow: 1, padding: 28, justifyContent: "center", backgroundColor: ui.background[0] },
  momentBrand: { position: "absolute", top: 18, right: 20, fontSize: 10, letterSpacing: 1.4, fontWeight: "800", color: ui.placeholder },
  momentLabel: { fontSize: 10, letterSpacing: 1.4, color: ui.accentInk, fontWeight: "700" },
  momentTitle: { marginTop: 10, fontSize: 32, lineHeight: 38, fontWeight: "700", color: ui.ink },
  momentDate: { marginTop: 8, fontSize: 12, color: ui.placeholder },
  momentRule: { marginVertical: 22, height: StyleSheet.hairlineWidth, backgroundColor: ui.line },
  momentBody: { fontSize: 16, lineHeight: 25, color: ui.ink, marginBottom: 24 },


  secondaryPage: { flex: 1, backgroundColor: ui.background[0] },

  lifePage: { padding: CHROME.screenInset, paddingBottom: 44 },
  lifeSub: { marginTop: 10, fontSize: 14, lineHeight: 22, color: ui.muted },
  lifeTimelineList: { marginTop: 22, gap: 10 },
  lifeContinuityCard: { padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, backgroundColor: ui.white },
  lifeContinuityTitle: { marginTop: 7, fontSize: 16, lineHeight: 22, fontWeight: "700", color: ui.ink },
  timelineCard: { flex: 1, marginLeft: 10, padding: 16, borderRadius: 16, backgroundColor: ui.white, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line },
  accountHandle: { marginTop: 3, fontSize: 11, color: ui.placeholder },
  accountArrow: { fontSize: 22, color: ui.placeholder, fontWeight: "300" },

  modalBackdrop: {
    flex: 1,
    backgroundColor: ui.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: ui.background[0],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
  },
  sheetHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: ui.line },
  sheetHeading: { marginTop: 12, paddingVertical: 8 },
  sheetTitle: { fontSize: 22, fontWeight: "700", textAlign: "center", color: ui.ink },
  sheetLabel: { marginTop: 22, marginBottom: 8, fontSize: 11, color: ui.placeholder },
  switchAccountRow: {
    minHeight: 70,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    backgroundColor: ui.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
  },
  switchAccountText: { flex: 1, marginLeft: 12 },
  switchAccountName: { fontSize: 14, fontWeight: "700", color: ui.ink },
  checkmark: { fontSize: 20, color: ui.ink },

  inlineNotice: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: ui.warningSurface,
  },
  inlineNoticeText: { fontSize: 11, color: ui.warning },
  center: { flex: 1, padding: 28, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: ui.background[0] },
  centerTitle: { fontSize: 22, lineHeight: 28, fontWeight: "700", textAlign: "center", color: ui.ink },
  centerBody: { maxWidth: 360, fontSize: 14, lineHeight: 21, color: ui.muted, textAlign: "center" },
  tinyMuted: { fontSize: 11, lineHeight: 17, color: ui.placeholder },
  disabled: { opacity: 0.38 },
  headerIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  mySocialPage: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 18,
  },
  heroBio: {
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  addCompanionCard: {
    width: 88,
    minHeight: 108,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
  },
  relTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  relSub: {
    fontSize: 11.5,
    marginTop: 2,
  },
  myCompanionIdentity: { gap: 4 },
  relControlBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  editProfilePill: {
    marginTop: 14,
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  editProfilePillText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: ui.accentInk,
  },
  relControlText: {
    fontSize: 12,
    fontWeight: "600",
  },


});
