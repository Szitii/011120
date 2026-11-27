import { useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  FlatList,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { setStringAsync } from "expo-clipboard";
import Ionicons from "@expo/vector-icons/Ionicons";
import type {
  ActorContext,
  CommunityDetail,
  CommunityProfile,
  CommunityPost,
  CommunityBlock,
  ReportTarget,
  CommunityPage,
  CommunityFeedMode,
} from "../../../contracts/community.ts";
import { ApiProblemError, communityWriteMessage, safeClientMessage, type CommunityWriteAction } from "../adapters/real-api.ts";
import { type FollowDirection } from "./CommunityFollowList.tsx";
import { communityRequestKey, type CommunityClient } from "./client.ts";
import type { CommunityTarget } from "../state/navigation";
import { CommunityRequestScope } from "./request-scope.ts";
import { ActorLine, CommunityButton as Button, ContentCard, communityIdentityLabel, useCommunityStyles } from "./components.tsx";
import { MentionChips, MentionPicker, type Mention } from "./MentionPicker";
import { UnifiedProfileView } from "../components/UnifiedProfileView";
import { ReportForm } from "./ReportForm.tsx";
import { HumanProfileEditor } from "./HumanProfileEditor.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { CompanionProfile, OwnerCompanionSummary } from "../contracts";

type Page = { type: "feed" } | CommunityTarget;

function buildPostShareUrl(postId: string): string | undefined {
  const base = process.env.EXPO_PUBLIC_COMMUNITY_SHARE_BASE_URL?.trim();
  if (!base) return;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(postId)}`;
    return url.href;
  } catch {
    return undefined;
  }
}

function mergeRows<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  return [...new Map([...previous, ...incoming].map(item => [item.id, item])).values()];
}

type Data =
  | { type: "feed"; value: CommunityPage<CommunityPost> }
  | { type: "profile"; profile: CommunityProfile; value: CommunityPage<CommunityPost> }
  | { type: "detail"; value: CommunityDetail }
  | { type: "blocks"; value: CommunityPage<CommunityBlock> };

export interface ManagedProfileActions {
  onChat?: () => void;
  onHome: () => void;
  onCommunitySettings: () => void;
  menu: { label: string; onPress: () => void }[];
}

const EMPTY_PROFILE_STATS = { postsCount: 0, followersCount: 0, followingCount: 0 };

export function CommunityScreen({
  client,
  viewer,
  initialScrollY = 0,
  onPublish,
  onNavigate,
  onFollowList,
  onBack,
  revision = 0,
  onChanged,
  onScroll,
  initialTarget,
  ownedCompanion,
  ownedCompanions,
  getManagedActions,
  legacyProfile,
  legacyProfileError,
  onRetryLegacyProfile,
}: {
  client?: CommunityClient;
  viewer: ActorContext;
  initialScrollY?: number;
  onPublish?: () => void;
  onNavigate: (target: CommunityTarget) => void;
  onFollowList: (direction: FollowDirection) => void;
  onBack: () => void;
  revision?: number;
  onChanged: () => void;
  onScroll: (y: number) => void;
  initialTarget?: CommunityTarget;
  ownedCompanion?: OwnerCompanionSummary;
  ownedCompanions?: OwnerCompanionSummary[];
  getManagedActions?: (companion: OwnerCompanionSummary) => ManagedProfileActions;
  legacyProfile?: CompanionProfile;
  legacyProfileError?: string;
  onRetryLegacyProfile?: () => void;
}) {
  const localStyles = useThemedStyles(createLocalStyles);
  const s = useCommunityStyles();
  const { skin, ui } = useSkin();
  const [reportTarget, setReportTarget] = useState<ReportTarget>();
  const [blockTarget, setBlockTarget] = useState<CommunityProfile>();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const page = useMemo<Page>(() => initialTarget ?? { type: "feed" }, [initialTarget]);
  const [mode, setMode] = useState<CommunityFeedMode>("LATEST");
  const [data, setData] = useState<Data>();
  const [own, setOwn] = useState<CommunityProfile>();
  const [ownUnavailable, setOwnUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [commentMentions, setCommentMentions] = useState<Mention[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const commentKey = useRef(communityRequestKey());

  const [editingProfile, setEditingProfile] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "posts" | "comments"; id: string }>();
  const [sharePostTarget, setSharePostTarget] = useState<CommunityPost>();
  const shareLink = sharePostTarget ? buildPostShareUrl(sharePostTarget.id) : undefined;
  const [shareBusy, setShareBusy] = useState(false);
  const [shareNotice, setShareNotice] = useState("");
  const sharePending = useRef(false);
  const scope = useMemo(() => new CommunityRequestScope(), []);
  const scroll = useRef<FlatList<CommunityPost>>(null);
  const feedY = useRef(initialScrollY);
  const restoreFeed = useRef(true);
  const active = useRef(true);
  const visibleProfile = useRef<CommunityProfile | undefined>(undefined);
  const managedId = ownedCompanion?.companionId;
  const managedReady = ownedCompanion?.socialReady === true;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      scope.invalidate();
    };
  }, [scope]);

  const load = useCallback(async (cursor?: string) => {
    const current = scope.begin();
    if (!client || (page.type === "profile" && page.companionId && !managedReady)) {
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    const ownRequest = cursor ? undefined : client.profile(viewer);
    void ownRequest?.then(
      (profile) => {
        if (current()) {
          setOwn(profile);
          setOwnUnavailable(false);
        }
      },
      () => {
        if (current()) {
          setOwn(undefined);
          setOwnUnavailable(true);
        }
      },
    );
    try {
      let next: Data;
      if (page.type === "profile") {
        const profile = cursor
          ? visibleProfile.current
          : await (managedId ? client.profile({ kind: "COMPANION", id: managedId })
            : page.id ? client.profile(viewer, page.id) : ownRequest);
        if (!profile || !current()) return;
        const value = await client.feed(viewer, { authorId: profile.id, ...(cursor ? { cursor } : {}) })
          .catch(error => {
            // A managed account can have a projection that's private to its own identity.
            if (managedId && error instanceof ApiProblemError && (error.status === 403 || error.status === 404)) {
              return { items: [], nextCursor: null };
            }
            throw error;
          });
        next = {
          type: "profile",
          profile,
          value,
        };
      } else if (page.type === "detail") {
        next = { type: "detail", value: await client.detail(viewer, page.id, cursor) };
      } else if (page.type === "blocks") {
        next = { type: "blocks", value: await client.blocks(viewer, cursor) };
      } else {
        next = {
          type: "feed",
          value: await client.feed(viewer, { mode, filter: "ALL", ...(cursor ? { cursor } : {}) }),
        };
      }
      if (!current()) return;
      if (next.type === "profile") visibleProfile.current = next.profile;
      setData((previous) => {
        if (!cursor || !previous || previous.type !== next.type) return next;
        if (next.type === "detail" && previous.type === "detail") {
          return {
            ...next,
            value: {
              ...next.value,
              comments: {
                ...next.value.comments,
                items: mergeRows(previous.value.comments.items, next.value.comments.items),
              },
            },
          };
        }
        if (next.type === "feed" && previous.type === "feed") {
          return { ...next, value: { ...next.value, items: mergeRows(previous.value.items, next.value.items) } };
        }
        if (next.type === "profile" && previous.type === "profile") {
          return { ...next, value: { ...next.value, items: mergeRows(previous.value.items, next.value.items) } };
        }
        if (next.type === "blocks" && previous.type === "blocks") {
          return { ...next, value: { ...next.value, items: mergeRows(previous.value.items, next.value.items) } };
        }
        return next;
      });
    } catch (e) {
      if (current()) {
        if (e instanceof ApiProblemError && (e.status === 403 || e.status === 404)) setData(undefined);
        setError(safeClientMessage(e).title);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [client, viewer.kind, viewer.id, page, mode, scope, managedId, managedReady]);

  useEffect(() => {
    setData(undefined);
    void load();
    return () => scope.invalidate();
  }, [load, scope]);

  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void load();
  }, [load, revision]);

  async function mutate<T>(action: () => Promise<T>, options: {
    success?: (result: T) => void;
    write?: CommunityWriteAction;
    nextPage?: Page;
    refreshCommunity?: boolean;
  } = {}) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (!active.current) return false;
      options.success?.(result);
      if (options.nextPage || options.refreshCommunity) onChanged();
      if (options.nextPage) navigate(options.nextPage, true);
      else if (!options.refreshCommunity) await load();
      return true;
    } catch (e) {
      if (active.current) setError(communityWriteMessage(e, viewer.kind, options.write));
      return false;
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }

  function toggleLike(post: CommunityPost) {
    if (!client?.like || loading) return;
    const like = client.like;
    void mutate(() => like(viewer, post.id, !post.likedByMe), { refreshCommunity: true, success: result => {
      const update = (item: CommunityPost) => item.id === post.id
        ? { ...item, likedByMe: result.liked, likeCount: result.likeCount } : item;
      setData(previous => {
        if (previous?.type === "detail") return { ...previous, value: { ...previous.value, post: update(previous.value.post) } };
        if (previous?.type === "feed" || previous?.type === "profile") {
          return { ...previous, value: { ...previous.value, items: previous.value.items.map(update) } };
        }
        return previous;
      });
      // Another mounted screen needs to refresh its copy. Keep this screen's current pagination.
      seenRevision.current = revision + 1;
    } });
  }

  function navigate(next: Page, afterWrite = false) {
    if (busyRef.current && !afterWrite) return;
    if (next.type === "feed") onBack();
    else if (next.type === "blocks") onNavigate(next);
    else onNavigate(next);
  }

  async function refresh() {
    if (busyRef.current || loading || refreshing) return;
    setRefreshing(true);
    try { await load(); } finally { if (active.current) setRefreshing(false); }
  }

  function remove(kind: "posts" | "comments", id: string) {
    if (busyRef.current) return;
    setDeleteTarget({ kind, id });
  }

  const posts = data?.type === "feed" || data?.type === "profile" ? data.value.items : [];
  const nextCursor = data?.type === "detail" ? data.value.comments.nextCursor : data?.value.nextCursor;
  const draftLimit = 2000;
  const draftLength = Array.from(commentDraft.trim()).length;
  const canSubmit = draftLength > 0 && draftLength <= draftLimit;
  const canCompose = own?.canPublish === true;
  const openActor = (id: string) => navigate({ type: "profile", id });
  const profile = data?.type === "profile" ? data.profile : undefined;
  const managed = ownedCompanion ?? (profile?.kind === "AI" && profile.handle
    ? ownedCompanions?.find(item => item.handle === profile.handle)
    : undefined);
  const managedActions = managed && getManagedActions?.(managed);
  const showSocialActions = Boolean(profile && !profile.isSelf && !managedActions);
  const profileName = profile?.displayName ?? managed?.displayName ?? legacyProfile?.displayName;
  const profileHandle = profile?.handle ?? managed?.handle ?? legacyProfile?.handle;
  const profileSubtitle = [profileHandle ? `@${profileHandle}` : undefined, communityIdentityLabel(profile?.kind)]
    .filter(Boolean).join(" · ");
  const legacyBio = legacyProfile?.publicProfile.bio;

  function openShareSheet(post: CommunityPost) {
    if (sharePending.current || post.visibility !== "PUBLIC") return;
    setShareNotice("");
    setSharePostTarget(post);
  }

  async function copyPost(post: CommunityPost, linkOnly: boolean) {
    if (sharePending.current || post.visibility !== "PUBLIC") return;
    const url = buildPostShareUrl(post.id);
    const text = linkOnly ? url : [post.body.trim(), url].filter(Boolean).join("\n");
    if (!text) return;
    sharePending.current = true;
    setShareBusy(true);
    try {
      const copied = await setStringAsync(text);
      if (!active.current) return;
      if (copied) {
        setSharePostTarget(undefined);
        setShareNotice(linkOnly ? "动态链接已复制。" : "分享内容已复制。");
      } else {
        setShareNotice("复制未完成，请稍后重试。");
      }
    } catch {
      if (active.current) setShareNotice("复制未完成，请稍后重试。");
    } finally {
      sharePending.current = false;
      if (active.current) setShareBusy(false);
    }
  }

  async function sharePost(post: CommunityPost) {
    if (post.visibility !== "PUBLIC") return;
    if (Platform.OS === "web") {
      await copyPost(post, false);
      return;
    }
    if (sharePending.current) return;
    const message = [post.body.trim(), buildPostShareUrl(post.id)].filter(Boolean).join("\n");
    if (!message) return;
    sharePending.current = true;
    setShareBusy(true);
    try {
      setSharePostTarget(undefined);
      await Share.share({ message });
    } catch {
      if (active.current) setShareNotice("未能调起系统分享，请稍后重试。");
    } finally {
      sharePending.current = false;
      if (active.current) setShareBusy(false);
    }
  }

  function editCommentMentions(mentions: Mention[]) {
    setCommentMentions(mentions);
    commentKey.current = communityRequestKey();
  }

  function closeConfirmation() {
    if (busyRef.current) return;
    setBlockTarget(undefined);
    setDeleteTarget(undefined);
    setError("");
  }

  function closeReport() {
    setReportTarget(undefined);
  }

  if (editingProfile && client) {
    return (
      <HumanProfileEditor
        client={client}
        viewer={viewer}
        avatar={own?.avatar}
        onClose={(saved) => {
          setEditingProfile(false);
          if (saved) void load();
        }}
      />
    );
  }

  const pageTitle =
    page.type === "profile"
      ? "主页"
      : page.type === "detail"
        ? "动态详情"
        : page.type === "blocks"
          ? "屏蔽管理"
          : "社区";

  const mediaCacheScope = `${viewer.kind}:${viewer.id}:${revision}`;
  return (
    <KeyboardAvoidingView style={skin.id === "default" ? s.communityPage : s.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        ref={scroll}
        data={posts}
        keyExtractor={post => post.id}
        renderItem={({ item: post }) => (
          <View style={localStyles.postCardGroup}>
            <ContentCard item={post}
              resolveMedia={client?.postMediaSource}
              cacheScope={mediaCacheScope}
              onActor={() => openActor(post.author.id)}
              onMention={openActor}
              onLike={client?.like ? () => toggleLike(post) : undefined}
              likeDisabled={busy || loading}
              onDetail={() => navigate({ type: "detail", id: post.id })}
              onDelete={() => remove("posts", post.id)}
              onReport={own && post.author.id !== own.id ? () => setReportTarget({ kind: "POST", id: post.id }) : undefined} />
            {post.visibility === "PUBLIC" && (
              <View style={localStyles.postShareRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="分享动态"
                  disabled={shareBusy}
                  onPress={() => openShareSheet(post)}
                  style={({ pressed }) => [localStyles.shareChip, pressed && { opacity: 0.68 }]}
                >
                  <Ionicons name="share-outline" size={14} color={ui.muted} />
                  <Text style={localStyles.shareChipText}>分享</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        ListFooterComponent={nextCursor ? <Button disabled={loading || busy} label="加载更多" onPress={() => void load(nextCursor)} /> : undefined}
        onEndReached={() => { if (nextCursor && !loading && !busy) void load(nextCursor); }}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={[s.content, s.feedContent]}
        onScroll={(e) => {
          if (page.type === "feed") {
            feedY.current = e.nativeEvent.contentOffset.y;
            onScroll(feedY.current);
          }
        }}
        scrollEventThrottle={120}
        onContentSizeChange={() => {
          if (page.type === "feed" && restoreFeed.current && data && !loading) {
            restoreFeed.current = false;
            scroll.current?.scrollToOffset({ offset: feedY.current, animated: false });
          }
        }}
        ListHeaderComponent={<View style={{ gap: 12 }}>
        {page.type === "feed" ? (
          <>
            {/* Clean Modern Feed Header: Tabs on Left, Compact Glass Icons + Compose Pill on Right */}
            <View style={localStyles.feedHeaderRow}>
              <View style={localStyles.modeTabs}>
                {(
                  [
                    ["LATEST", "最新"],
                    ["FOLLOWING", "关注"],
                  ] as const
                ).map(([key, label]) => {
                  const activeTab = mode === key;
                  return (
                    <Pressable
                      key={key}
                      disabled={busy}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: activeTab }}
                      onPress={() => setMode(key)}
                      style={localStyles.modeTabBtn}
                    >
                      <Text style={[localStyles.modeTabText, activeTab && localStyles.modeTabTextActive]}>
                        {label}
                      </Text>
                      {activeTab && <View style={localStyles.modeTabIndicator} />}
                    </Pressable>
                  );
                })}
              </View>

              <View style={localStyles.headerActions}>
                {canCompose && onPublish && (
                  <Pressable
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="发布动态"
                    onPress={onPublish}
                    style={({ pressed }) => [localStyles.composePill, pressed && { transform: [{ scale: 0.94 }] }]}
                  >
                    <Ionicons name="add" size={15} color={ui.onAccent} />
                    <Text style={localStyles.composePillText}>发动态</Text>
                  </Pressable>
                )}
              </View>
            </View>

          </>
        ) : (
          /* Clean Modern Sub-page Header: Back + Title + Contextual Action */
          <View style={localStyles.subHeader}>
            <Text style={localStyles.subTitle}>{pageTitle}</Text>
            <View style={localStyles.subHeaderRight}>
              {(managedActions || profile) && (
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="更多主页操作"
                  onPress={() => setProfileMenuOpen(true)}
                  style={({ pressed }) => [localStyles.profileMenuButton, pressed && { opacity: 0.7 }]}
                >
                  <Ionicons name="ellipsis-horizontal" size={22} color={ui.ink} />
                </Pressable>
              )}
            </View>
          </View>
        )}

        {shareNotice !== "" && !sharePostTarget && (
          <View style={localStyles.noticePill}>
            <Text accessibilityLiveRegion="polite" style={s.meta}>{shareNotice}</Text>
          </View>
        )}

        {error !== "" && !blockTarget && !deleteTarget && (
          <Text accessibilityRole="alert" style={s.error}>
            {error} 可刷新后重试；发布失败时草稿会保留。
          </Text>
        )}
        {ownUnavailable && (
          <Text accessibilityRole="alert" style={s.error}>
            当前身份资料暂时无法加载，部分操作不可用。可刷新后重试。
          </Text>
        )}
        {loading && <ActivityIndicator accessibilityLabel="正在加载社区" color={ui.accent} />}

        {legacyProfileError && (
          <View style={s.card}>
            <Text accessibilityRole="alert" style={s.error}>{legacyProfileError}</Text>
            {onRetryLegacyProfile && <Button label="重新加载" onPress={onRetryLegacyProfile} />}
          </View>
        )}
        {page.type === "profile" && page.companionId && !profileName && !legacyProfileError && !loading &&
          <ActivityIndicator accessibilityLabel="正在加载主页" color={ui.accent} />}

        {profileName && (
          <View style={s.card}>
            <UnifiedProfileView name={profileName}
              role={profile?.kind === "HUMAN" ? "owner" : "companion"}
              avatar={profile?.avatar ?? managed?.avatar}
              subtitle={profileSubtitle}
              bio={profile?.bio ?? (typeof legacyBio === "string" ? legacyBio : undefined)}
              stats={profile ?? (managed && managed.socialReady !== true ? EMPTY_PROFILE_STATS : undefined)}
              onFollowList={profile?.isSelf && !managedActions && !busy ? onFollowList : undefined}
              afterBio={managedActions && managed?.socialReady !== true && (
                <Pressable accessibilityRole="button" onPress={managedActions.onCommunitySettings}
                  style={localStyles.profilePrompt}>
                  <Text style={localStyles.profilePromptText}>尚未公开到社区，点击开启</Text>
                </Pressable>
              )}
            >
              <View style={s.row}>
                {managedActions ? (
                  <>
                    {managedActions.onChat && <Button label="聊天" primary onPress={managedActions.onChat} />}
                    <Button label="去小家" onPress={managedActions.onHome} />
                  </>
                ) : profile?.isSelf && profile.kind === "HUMAN" ? (
                  <Button label="编辑资料" disabled={busy} onPress={() => setEditingProfile(true)} />
                ) : showSocialActions && profile && client ? (
                  <Button
                    primary={!profile.following}
                    selected={profile.following}
                    disabled={busy || (!profile.following && !own?.canPublish)}
                    label={profile.following ? "已关注" : "关注"}
                    onPress={() => void mutate(
                      () => client.follow(viewer, profile.id, !profile.following, communityRequestKey()),
                      { write: profile.following ? "取关" : "关注", refreshCommunity: true },
                    )}
                  />
                ) : null}
              </View>
            </UnifiedProfileView>
          </View>
        )}

        {page.type === "profile" && profileName && !loading && !error && posts.length === 0 && (
          <View style={localStyles.emptyCard}>
            <Text style={localStyles.emptyText}>{legacyProfile ? "暂时没有可显示的社区动态。" : "暂无动态"}</Text>
          </View>
        )}

        {/* Blocked Users List */}
        {client && data?.type === "blocks" &&
          data.value.items.map((block) => (
            <View key={block.id} style={s.card}>
              <View style={localStyles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <ActorLine actor={block.actor} subtitle={block.actor.handle ? `@${block.actor.handle}` : undefined} />
                </View>
                <Button
                  label="取消屏蔽"
                  disabled={busy}
                  onPress={() => void mutate(() => client.block(viewer, block.id, false, communityRequestKey()))}
                />
              </View>
            </View>
          ))}

        {own && !own.canPublish && page.type === "feed" && (
          <View style={localStyles.noticePill}>
            <Text style={s.meta}>当前家机尚未开放公开发布，请前往「我的」页右上角的设置。</Text>
          </View>
        )}

        {/* Post Detail & Comments */}
        {client && data?.type === "detail" && (
          <>
            <View style={localStyles.postCardGroup}>
              <ContentCard
                item={data.value.post}
                resolveMedia={client.postMediaSource}
                cacheScope={mediaCacheScope}
                onActor={() => openActor(data.value.post.author.id)}
                onMention={openActor}
                onLike={client.like ? () => toggleLike(data.value.post) : undefined}
                likeDisabled={busy || loading}
                onDelete={() => remove("posts", data.value.post.id)}
                onReport={
                  own && data.value.post.author.id !== own.id
                    ? () => setReportTarget({ kind: "POST", id: data.value.post.id })
                    : undefined
                }
              />
              {data.value.post.visibility === "PUBLIC" && (
                <View style={localStyles.postShareRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="分享动态"
                    disabled={shareBusy}
                    onPress={() => openShareSheet(data.value.post)}
                    style={({ pressed }) => [localStyles.shareChip, pressed && { opacity: 0.68 }]}
                  >
                    <Ionicons name="share-outline" size={14} color={ui.muted} />
                    <Text style={localStyles.shareChipText}>分享</Text>
                  </Pressable>
                </View>
              )}
            </View>
            {canCompose && (
              <View style={s.card}>
                <Text style={s.meta}>
                  {viewer.kind === "OWNER" ? "发表评论" : "以家机身份发表评论"}
                </Text>
                <TextInput
                  accessibilityLabel="评论内容"
                  multiline
                  editable={!busy}
                  placeholder="写下你的回应…"
                  placeholderTextColor={ui.placeholder}
                  value={commentDraft}
                  style={[s.input, { minHeight: 74 }]}
                  onChangeText={(text) => {
                    setCommentDraft(text);
                    commentKey.current = communityRequestKey();
                  }}
                />
                <MentionChips mentions={commentMentions} disabled={busy}
                  onRemove={id => editCommentMentions(commentMentions.filter(mention => mention.id !== id))} />
                <Text style={draftLength > draftLimit ? s.error : s.meta}>{draftLength} / {draftLimit}</Text>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Button label="@ 提及" disabled={busy || loading}
                    onPress={() => { Keyboard.dismiss(); setMentionOpen(true); }} />
                  <Button
                    primary
                    disabled={busy || loading || !canSubmit}
                    label={busy ? "正在提交…" : "发表评论"}
                    onPress={() =>
                      void mutate(
                        () => client.comment(viewer, data.value.post.id, commentDraft, commentKey.current, {
                          mentions: commentMentions.map(mention => mention.id),
                        }),
                        { write: "评论", success: () => {
                          setCommentDraft("");
                          editCommentMentions([]);
                        } },
                      )
                    }
                  />
                </View>
              </View>
            )}
            <Text style={localStyles.sectionLabel}>评论（{data.value.post.commentsCount}）</Text>
            {data.value.comments.items.map((comment) => (
              <ContentCard
                key={comment.id}
                item={comment}
                onActor={() => openActor(comment.author.id)}
                onMention={openActor}
                highlighted={page.type === "detail" && comment.id === page.commentId}
                onDelete={() => remove("comments", comment.id)}
                onReport={
                  own && comment.author.id !== own.id
                    ? () => setReportTarget({ kind: "COMMENT", id: comment.id })
                    : undefined
                }
              />
            ))}
            {mentionOpen && own && <MentionPicker client={client} viewer={viewer} selfId={own.id}
              related={[data.value.post.author, ...data.value.comments.items.map(comment => comment.author)]}
              selected={commentMentions} onChange={editCommentMentions} onClose={() => setMentionOpen(false)} />}
            {data.value.comments.items.length === 0 && (
              <View style={localStyles.emptyCard}>
                <Text style={s.meta}>还没有评论，来留第一条吧。</Text>
              </View>
            )}
          </>
        )}

        {/* Empty State */}
        {!loading && (data?.type === "feed" || data?.type === "blocks") && data.value.items.length === 0 && (
          <View style={localStyles.emptyCard}>
            <Ionicons
              name={
                page.type === "blocks" ? "shield-checkmark-outline" : "chatbubbles-outline"
              }
              size={22}
              color={ui.accent}
            />
            <Text style={localStyles.emptyText}>
              {page.type === "blocks"
                ? "当前身份没有屏蔽其他居民。"
                : mode === "FOLLOWING" && page.type === "feed"
                    ? "关注一些居民后，他们的动态会出现在这里。"
                    : "还没有动态，点右上角「发动态」写下第一条吧。"}
            </Text>
          </View>
        )}

        </View>}
      />

      <BottomSheet
        visible={Boolean(sharePostTarget)}
        title="分享动态"
        onClose={() => {
          if (shareBusy) return;
          setSharePostTarget(undefined);
        }}
      >
        {sharePostTarget && (
          <View style={localStyles.profileMenu}>
            {sharePostTarget.body.trim() !== "" && (
              <Text style={s.meta} numberOfLines={3}>{sharePostTarget.body}</Text>
            )}
            {shareLink && <Text style={s.meta} numberOfLines={1} selectable>{shareLink}</Text>}
            {shareNotice !== "" && <Text accessibilityRole="alert" style={s.meta}>{shareNotice}</Text>}
            <Button
              primary
              disabled={shareBusy || (!sharePostTarget.body.trim() && !shareLink)}
              label={Platform.OS === "web" ? "复制分享内容" : "系统分享"}
              onPress={() => void sharePost(sharePostTarget)}
            />
            {shareLink && <Button
              disabled={shareBusy}
              label="复制链接"
              onPress={() => void copyPost(sharePostTarget, true)}
            />}
          </View>
        )}
      </BottomSheet>

      <BottomSheet visible={profileMenuOpen} title={managedActions ? "家机管理" : "更多主页操作"}
        onClose={() => setProfileMenuOpen(false)}>
        <View style={localStyles.profileMenu}>
          {managedActions?.menu.map(({ label, onPress }) => (
            <Button key={label} label={label} onPress={() => {
              setProfileMenuOpen(false);
              onPress();
            }} />
          ))}
          {showSocialActions && profile && <>
            <Button label="举报" onPress={() => {
              setProfileMenuOpen(false);
              setReportTarget({ kind: "ACTOR", id: profile.id });
            }} />
            <Button label="屏蔽对方" onPress={() => {
              setProfileMenuOpen(false);
              setBlockTarget(profile);
            }} />
          </>}
          {profile?.isSelf && !managedActions && <Button label="屏蔽管理" onPress={() => {
            setProfileMenuOpen(false);
            navigate({ type: "blocks" });
          }} />}
        </View>
      </BottomSheet>

      {/* Block / Delete Confirmation Sheet */}
      <BottomSheet
        visible={Boolean(blockTarget || deleteTarget)}
        title={blockTarget ? "屏蔽对方" : "删除内容"}
        onClose={closeConfirmation}
      >
        {client && blockTarget && (
          <>
            <Text style={[s.body, { color: skin.colors.ink, marginBottom: 12 }]}>
              屏蔽 {blockTarget.displayName}？这会屏蔽对方的全部关联身份。当前身份将与对方互不可见，不能关注或评论，已有的双向关注也会解除。
            </Text>
            <View style={s.row}>
              <Button label="取消" disabled={busy} onPress={closeConfirmation} />
              <Button
                primary
                label="确认屏蔽"
                disabled={busy}
                onPress={() => {
                  const target = blockTarget;
                  void mutate(
                    () => client.block(viewer, target.id, true, communityRequestKey()),
                    { nextPage: { type: "blocks" } },
                  );
                }}
              />
            </View>
          </>
        )}
        {client && deleteTarget && (
          <>
            <Text style={[s.body, { color: skin.colors.ink, marginBottom: 12 }]}>
              删除这条内容？删除后将从社区和相关通知中隐藏。
            </Text>
            <View style={s.row}>
              <Button label="取消" disabled={busy} onPress={closeConfirmation} />
              <Button
                primary
                label="确认删除"
                disabled={busy}
                onPress={() => {
                  const target = deleteTarget;
                  const postMediaPaths = target.kind === "posts"
                    ? (data?.type === "detail" && data.value.post.id === target.id
                        ? data.value.post.media
                        : posts.find(item => item.id === target.id)?.media)?.map(media => media.path) ?? []
                    : [];
                  void mutate(
                    () => client.remove(viewer, target.kind, target.id, communityRequestKey()),
                    {
                      success: () => {
                        setDeleteTarget(undefined);
                        for (const mediaPath of postMediaPaths) {
                          void client.deletePostMedia?.(mediaPath).catch(() => undefined);
                        }
                      },
                      nextPage: target.kind === "posts" && page.type === "detail" && page.id === target.id ? { type: "feed" } : undefined,
                    },
                  );
                }}
              />
            </View>
          </>
        )}
        {error !== "" && (
          <Text accessibilityRole="alert" style={[s.error, { marginTop: 10 }]}>
            {error} 请重试。
          </Text>
        )}
      </BottomSheet>

      {client && reportTarget && (
        <Modal animationType="slide" onRequestClose={closeReport}>
          <SafeAreaView style={s.page}>
            <ReportForm client={client} viewer={viewer} target={reportTarget} onClose={closeReport} />
          </SafeAreaView>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

const createLocalStyles = (ui: UiPalette) => StyleSheet.create({
  feedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 2,
    paddingBottom: 2,
  },
  modeTabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
  },
  modeTabBtn: {
    paddingVertical: 6,
    alignItems: "center",
  },
  modeTabText: {
    fontSize: 17,
    fontWeight: "500",
    color: ui.muted,
  },
  modeTabTextActive: {
    fontSize: 19,
    fontWeight: "700",
    color: ui.ink,
  },
  modeTabIndicator: {
    marginTop: 4,
    width: 18,
    height: 3,
    borderRadius: 2,
    backgroundColor: ui.accent,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  profileMenuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center",
    borderRadius: RADIUS.pill, backgroundColor: ui.accentWash },
  profileMenu: { gap: 8 },
  profilePrompt: { minHeight: 44, justifyContent: "center" },
  profilePromptText: { fontSize: 13, color: ui.accentInk, textAlign: "center" },
  composePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
    shadowColor: ui.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 2,
  },
  composePillText: {
    color: ui.onAccent,
    fontSize: 12.5,
    fontWeight: "600",
  },

  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  subTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: ui.ink,
  },
  subHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: ui.muted,
    marginTop: 4,
  },
  noticePill: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: ui.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
  },
  postCardGroup: {
    gap: 6,
  },
  postShareRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
    paddingHorizontal: 8,
  },
  shareChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
  },
  shareChipText: {
    fontSize: 12,
    fontWeight: "500",
    color: ui.muted,
  },
  emptyCard: {
    paddingVertical: 32,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.highlight,
    alignItems: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    color: ui.muted,
    textAlign: "center",
    lineHeight: 20,
  },
});
