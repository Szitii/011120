import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type {
  ActorContext,
  CommunityDetail,
  CommunityProfile,
  CommunityPost,
  CommunityBlock,
  ReportTarget,
  CommunityPage,
  CommunityNotification,
  CommunityFeedMode,
  CommunityActorFilter,
} from "../../../contracts/community.ts";
import { communityWriteMessage, safeClientMessage, type CommunityWriteAction } from "../adapters/real-api.ts";
import { CommunityFollowList, type FollowDirection } from "./CommunityFollowList.tsx";
import { communityRequestKey, type CommunityClient } from "./client.ts";
import { CommunityRequestScope } from "./request-scope.ts";
import { ActorLine, CommunityButton as Button, ContentCard, communityStyles as s } from "./components.tsx";
import { ReportForm } from "./ReportForm.tsx";
import { HumanProfileEditor } from "./HumanProfileEditor.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { useSkin } from "../theme/SkinProvider";
import { PEARL_UI } from "../theme/skinTokens";
import { RADIUS } from "../theme/layoutTokens";

type Page =
  | { type: "feed" }
  | { type: "profile"; id?: string }
  | { type: "detail"; id: string }
  | { type: "notifications" }
  | { type: "blocks" };

type Data =
  | { type: "feed"; value: CommunityPage<CommunityPost> }
  | { type: "profile"; profile: CommunityProfile; value: CommunityPage<CommunityPost> }
  | { type: "detail"; value: CommunityDetail }
  | { type: "notifications"; value: CommunityPage<CommunityNotification> }
  | { type: "blocks"; value: CommunityPage<CommunityBlock> };

export function CommunityScreen({
  client,
  viewer,
  initialScrollY = 0,
  onScroll,
}: {
  client: CommunityClient;
  viewer: ActorContext;
  initialScrollY?: number;
  onScroll: (y: number) => void;
}) {
  const { skin } = useSkin();
  const [followDirection, setFollowDirection] = useState<FollowDirection>();
  const [reportTarget, setReportTarget] = useState<ReportTarget>();
  const [blockTarget, setBlockTarget] = useState<CommunityProfile>();
  const [page, setPage] = useState<Page>({ type: "feed" });
  const [mode, setMode] = useState<CommunityFeedMode>("LATEST");
  const [filter, setFilter] = useState<CommunityActorFilter>("ALL");
  const [data, setData] = useState<Data>();
  const [own, setOwn] = useState<CommunityProfile>();
  const [ownUnavailable, setOwnUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const draftKey = useRef(communityRequestKey());
  const [editingProfile, setEditingProfile] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "posts" | "comments"; id: string }>();
  const scope = useMemo(() => new CommunityRequestScope(), []);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const feedY = useRef(initialScrollY);
  const restoreFeed = useRef(true);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      scope.invalidate();
    };
  }, [scope]);

  const load = useCallback(async (cursor?: string) => {
    const current = scope.begin();
    setLoading(true);
    setError("");
    const ownProfile = client.profile(viewer).then(
      (profile) => {
        if (current()) {
          setOwn(profile);
          setOwnUnavailable(false);
        }
        return profile;
      },
      () => {
        if (current()) {
          setOwn(undefined);
          setOwnUnavailable(true);
        }
        return undefined;
      },
    );
    try {
      let next: Data;
      if (page.type === "profile") {
        const profile = page.id ? await client.profile(viewer, page.id) : await ownProfile;
        if (!profile || !current()) return;
        next = {
          type: "profile",
          profile,
          value: await client.feed(viewer, { authorId: profile.id, ...(cursor ? { cursor } : {}) }),
        };
      } else if (page.type === "detail") {
        next = { type: "detail", value: await client.detail(viewer, page.id, cursor) };
      } else if (page.type === "blocks") {
        next = { type: "blocks", value: await client.blocks(viewer, cursor) };
      } else if (page.type === "notifications") {
        next = { type: "notifications", value: await client.notifications(viewer, cursor) };
      } else {
        next = {
          type: "feed",
          value: await client.feed(viewer, { mode, filter, ...(cursor ? { cursor } : {}) }),
        };
      }
      if (!current()) return;
      setData((previous) => {
        if (!cursor || !previous || previous.type !== next.type) return next;
        if (next.type === "detail" && previous.type === "detail") {
          return {
            ...next,
            value: {
              ...next.value,
              comments: {
                ...next.value.comments,
                items: [...previous.value.comments.items, ...next.value.comments.items],
              },
            },
          };
        }
        if (next.type === "feed" && previous.type === "feed") {
          return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        }
        if (next.type === "profile" && previous.type === "profile") {
          return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        }
        if (next.type === "notifications" && previous.type === "notifications") {
          return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        }
        if (next.type === "blocks" && previous.type === "blocks") {
          return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        }
        return next;
      });
    } catch (e) {
      if (current()) setError(safeClientMessage(e).title);
    } finally {
      if (current()) setLoading(false);
    }
  }, [client, viewer.kind, viewer.id, page, mode, filter, scope]);

  useEffect(() => {
    setData(undefined);
    void load();
    return () => scope.invalidate();
  }, [load, scope]);

  async function mutate(action: () => Promise<unknown>, success?: () => void, write?: CommunityWriteAction) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (!active.current) return false;
      success?.();
      await load();
      return true;
    } catch (e) {
      if (active.current) setError(communityWriteMessage(e, viewer.kind, write));
      return false;
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  }

  function navigate(next: Page) {
    if (busyRef.current) return;
    scope.invalidate();
    if (next.type !== "feed") {
      setDraft("");
      draftKey.current = communityRequestKey();
    }
    setBlockTarget(undefined);
    setDeleteTarget(undefined);
    setComposeOpen(false);
    setData(undefined);
    setPage(next);
    restoreFeed.current = next.type === "feed";
    if (next.type !== "feed") scroll.current?.scrollTo({ y: 0, animated: false });
  }

  function remove(kind: "posts" | "comments", id: string) {
    if (busyRef.current) return;
    setDeleteTarget({ kind, id });
  }

  const posts = data?.type === "feed" || data?.type === "profile" ? data.value.items : [];
  const nextCursor = data?.type === "detail" ? data.value.comments.nextCursor : data?.value.nextCursor;
  const draftLimit = page.type === "detail" ? 2000 : 4000;
  const draftLength = Array.from(draft.trim()).length;
  const canSubmit = draftLength > 0 && draftLength <= draftLimit;
  const canCompose = own?.canPublish === true;
  const openActor = (id: string) => navigate({ type: "profile", id });

  function closeConfirmation() {
    if (busyRef.current) return;
    setBlockTarget(undefined);
    setDeleteTarget(undefined);
    setError("");
  }

  function closeReport() {
    setReportTarget(undefined);
  }

  if (editingProfile) {
    return (
      <HumanProfileEditor
        client={client}
        viewer={viewer}
        onClose={(saved) => {
          setEditingProfile(false);
          if (saved) void load();
        }}
      />
    );
  }

  const pageTitle =
    page.type === "profile"
      ? "独立主页"
      : page.type === "detail"
        ? "动态详情"
        : page.type === "blocks"
          ? "屏蔽管理"
          : "通知";

  return (
    <View style={skin.id === "default" ? s.communityPage : s.page}>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
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
            scroll.current?.scrollTo({ y: feedY.current, animated: false });
          }
        }}
      >
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
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="当前身份通知"
                  onPress={() => navigate({ type: "notifications" })}
                  style={({ pressed }) => [localStyles.glassIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
                >
                  <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
                  <Ionicons name="notifications-outline" size={17} color={PEARL_UI.ink} />
                </Pressable>
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="我的社区主页"
                  onPress={() => navigate({ type: "profile" })}
                  style={({ pressed }) => [localStyles.glassIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
                >
                  <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
                  <Ionicons name="person-outline" size={16} color={PEARL_UI.ink} />
                </Pressable>
                <Pressable
                  disabled={loading || busy}
                  accessibilityRole="button"
                  accessibilityLabel="刷新"
                  onPress={() => void load()}
                  style={({ pressed }) => [localStyles.glassIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
                >
                  <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
                  <Ionicons name="refresh-outline" size={16} color={PEARL_UI.ink} />
                </Pressable>
                {canCompose && (
                  <Pressable
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="发布动态"
                    onPress={() => {
                      setError("");
                      setComposeOpen(true);
                    }}
                    style={({ pressed }) => [localStyles.composePill, pressed && { transform: [{ scale: 0.94 }] }]}
                  >
                    <Ionicons name="add" size={15} color="#FFFFFF" />
                    <Text style={localStyles.composePillText}>发动态</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {/* Compact Filter Row */}
            <View style={localStyles.filterRow}>
              <View style={s.row}>
                {(
                  [
                    ["ALL", "全部"],
                    ["HUMAN", "人类"],
                    ["AI", "家机"],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    label={label}
                    glass
                    disabled={busy}
                    selected={filter === key}
                    onPress={() => setFilter(key)}
                  />
                ))}
              </View>
            </View>
          </>
        ) : (
          /* Clean Modern Sub-page Header: Back + Title + Contextual Action */
          <View style={localStyles.subHeader}>
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              onPress={() => navigate({ type: "feed" })}
              style={({ pressed }) => [localStyles.backPill, pressed && { transform: [{ scale: 0.94 }] }]}
            >
              <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
              <Ionicons name="chevron-back" size={16} color={PEARL_UI.ink} />
              <Text style={localStyles.backText}>返回</Text>
            </Pressable>
            <Text style={localStyles.subTitle}>{pageTitle}</Text>
            <View style={localStyles.subHeaderRight}>
              {page.type === "profile" && data?.type === "profile" && data.profile.isSelf && (
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="屏蔽管理"
                  onPress={() => navigate({ type: "blocks" })}
                  style={({ pressed }) => [localStyles.glassIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
                >
                  <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
                  <Ionicons name="ban-outline" size={16} color={PEARL_UI.ink} />
                </Pressable>
              )}
              <Pressable
                disabled={loading || busy}
                accessibilityRole="button"
                accessibilityLabel="刷新"
                onPress={() => void load()}
                style={({ pressed }) => [localStyles.glassIconBtn, pressed && { transform: [{ scale: 0.92 }] }]}
              >
                <LiquidGlassSurface glass style={StyleSheet.absoluteFill} />
                <Ionicons name="refresh-outline" size={16} color={PEARL_UI.ink} />
              </Pressable>
            </View>
          </View>
        )}

        {error !== "" && !blockTarget && !deleteTarget && !composeOpen && (
          <Text accessibilityRole="alert" style={s.error}>
            {error} 可刷新后重试；发布失败时草稿会保留。
          </Text>
        )}
        {ownUnavailable && (
          <Text accessibilityRole="alert" style={s.error}>
            当前身份资料暂时无法加载，部分操作不可用。可刷新后重试。
          </Text>
        )}
        {loading && <ActivityIndicator accessibilityLabel="正在加载社区" color={PEARL_UI.accent} />}

        {/* Profile Card */}
        {data?.type === "profile" && (
          <View style={s.card}>
            <ActorLine actor={data.profile} onPress={() => undefined} subtitle={`@${data.profile.handle}`} />
            {data.profile.bio !== "" && <Text style={s.body}>{data.profile.bio}</Text>}
            {data.profile.isSelf ? (
              <View style={s.row}>
                <Text style={s.meta}>动态 {data.profile.postsCount}</Text>
                <Button
                  label={`关注 ${data.profile.followingCount}`}
                  disabled={busy}
                  onPress={() => setFollowDirection("following")}
                />
                <Button
                  label={`粉丝 ${data.profile.followersCount}`}
                  disabled={busy}
                  onPress={() => setFollowDirection("followers")}
                />
              </View>
            ) : (
              <Text style={s.meta}>
                动态 {data.profile.postsCount} · 关注 {data.profile.followingCount} · 粉丝 {data.profile.followersCount}
              </Text>
            )}
            <View style={s.row}>
              {data.profile.isSelf ? (
                data.profile.kind === "HUMAN" ? (
                  <Button label="编辑资料" disabled={busy} onPress={() => setEditingProfile(true)} />
                ) : (
                  <Text style={s.meta}>当前操作身份的独立主页</Text>
                )
              ) : (
                <>
                  <Button
                    primary={!data.profile.following}
                    disabled={busy || (!data.profile.following && !own?.canPublish)}
                    label={data.profile.following ? "取消关注" : "关注"}
                    onPress={() => {
                      const p = data.profile;
                      void mutate(
                        () => client.follow(viewer, p.id, !p.following, communityRequestKey()),
                        undefined,
                        p.following ? "取关" : "关注",
                      );
                    }}
                  />
                  <Button label="屏蔽对方" disabled={busy} onPress={() => setBlockTarget(data.profile)} />
                  <Button
                    label="举报"
                    disabled={busy}
                    onPress={() => setReportTarget({ kind: "ACTOR", id: data.profile.id })}
                  />
                </>
              )}
            </View>
          </View>
        )}

        {/* Blocked Users List */}
        {data?.type === "blocks" &&
          data.value.items.map((block) => (
            <View key={block.id} style={s.card}>
              <View style={localStyles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text style={s.author}>{block.actor.displayName}</Text>
                  <Text style={s.meta}>@{block.actor.handle}</Text>
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

        {/* Feed / Profile Posts */}
        {posts.map((post) => (
          <ContentCard
            key={post.id}
            item={post}
            onActor={() => openActor(post.author.id)}
            onDetail={() => navigate({ type: "detail", id: post.id })}
            onDelete={() => remove("posts", post.id)}
            onReport={own && post.author.id !== own.id ? () => setReportTarget({ kind: "POST", id: post.id }) : undefined}
          />
        ))}

        {/* Post Detail & Comments */}
        {data?.type === "detail" && (
          <>
            <ContentCard
              item={data.value.post}
              onActor={() => openActor(data.value.post.author.id)}
              onDelete={() => remove("posts", data.value.post.id)}
              onReport={
                own && data.value.post.author.id !== own.id
                  ? () => setReportTarget({ kind: "POST", id: data.value.post.id })
                  : undefined
              }
            />
            {canCompose && (
              <View style={s.card}>
                <Text style={s.meta}>
                  {viewer.kind === "OWNER" ? "发表评论" : "以家机身份 · Owner 代发评论"}
                </Text>
                <TextInput
                  accessibilityLabel="评论内容"
                  multiline
                  editable={!busy}
                  placeholder="写下你的回应…"
                  placeholderTextColor="#9A968F"
                  value={draft}
                  style={[s.input, { minHeight: 74 }]}
                  onChangeText={(text) => {
                    setDraft(text);
                    draftKey.current = communityRequestKey();
                  }}
                />
                <Text style={draftLength > draftLimit ? s.error : s.meta}>{draftLength} / {draftLimit}</Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Button
                    primary
                    disabled={busy || loading || !canSubmit}
                    label={busy ? "正在提交…" : "发表评论"}
                    onPress={() =>
                      void mutate(
                        () => client.comment(viewer, data.value.post.id, draft, draftKey.current),
                        () => {
                          setDraft("");
                          draftKey.current = communityRequestKey();
                        },
                        "评论",
                      )
                    }
                  />
                </View>
              </View>
            )}
            <Text style={localStyles.sectionLabel}>评论（{data.value.comments.items.length}）</Text>
            {data.value.comments.items.map((comment) => (
              <ContentCard
                key={comment.id}
                item={comment}
                onActor={() => openActor(comment.author.id)}
                onDelete={() => remove("comments", comment.id)}
                onReport={
                  own && comment.author.id !== own.id
                    ? () => setReportTarget({ kind: "COMMENT", id: comment.id })
                    : undefined
                }
              />
            ))}
            {data.value.comments.items.length === 0 && (
              <View style={localStyles.emptyCard}>
                <Text style={s.meta}>还没有评论，来留第一条吧。</Text>
              </View>
            )}
          </>
        )}

        {/* Notifications */}
        {data?.type === "notifications" &&
          data.value.items.map((note) => (
            <View key={note.id} style={s.card}>
              <ActorLine
                actor={note.actor}
                onPress={() => openActor(note.actor.id)}
                subtitle={note.kind === "FOLLOW" ? "关注了你" : "评论了你的动态"}
              />
              <View style={s.row}>
                <Button
                  primary={!note.readAt}
                  disabled={busy}
                  label="查看"
                  onPress={() =>
                    void mutate(() => client.readNotification(viewer, note.id, communityRequestKey())).then((ok) => {
                      if (ok && active.current) {
                        navigate(note.postId ? { type: "detail", id: note.postId } : { type: "profile", id: note.actor.id });
                      }
                    })
                  }
                />
                {!note.readAt && (
                  <Button
                    disabled={busy}
                    label="标为已读"
                    onPress={() => void mutate(() => client.readNotification(viewer, note.id, communityRequestKey()))}
                  />
                )}
              </View>
            </View>
          ))}

        {/* Empty State */}
        {!loading && data?.type !== "detail" && data?.value.items.length === 0 && (
          <View style={localStyles.emptyCard}>
            <Ionicons
              name={
                page.type === "notifications"
                  ? "notifications-off-outline"
                  : page.type === "blocks"
                    ? "shield-checkmark-outline"
                    : "chatbubbles-outline"
              }
              size={22}
              color={PEARL_UI.accent}
            />
            <Text style={localStyles.emptyText}>
              {page.type === "blocks"
                ? "当前身份没有屏蔽其他居民。"
                : page.type === "notifications"
                  ? "当前身份暂时没有通知。"
                  : mode === "FOLLOWING" && page.type === "feed"
                    ? "关注一些居民后，他们的动态会出现在这里。"
                    : "还没有动态，点右上角「发动态」写下第一条吧。"}
            </Text>
          </View>
        )}

        {nextCursor && <Button disabled={loading || busy} label="加载更多" onPress={() => void load(nextCursor)} />}
      </ScrollView>

      {/* Sleek Compose BottomSheet (preserves draft on publish error) */}
      <BottomSheet
        visible={composeOpen && canCompose && page.type === "feed"}
        title={viewer.kind === "OWNER" ? "发布公开动态" : "以家机身份发动态"}
        badge={viewer.kind === "OWNER" ? undefined : "Owner 代发"}
        onClose={() => {
          if (!busyRef.current) setComposeOpen(false);
        }}
      >
        <TextInput
          accessibilityLabel="动态内容"
          multiline
          editable={!busy}
          placeholder="写下今天的小事或心情…"
          placeholderTextColor="#9A968F"
          value={draft}
          style={[s.input, { marginBottom: 12 }]}
          onChangeText={(text) => {
            setDraft(text);
            draftKey.current = communityRequestKey();
          }}
        />
        <Text style={draftLength > draftLimit ? s.error : s.meta}>{draftLength} / {draftLimit}</Text>
        {error !== "" && (
          <Text accessibilityRole="alert" style={[s.error, { marginBottom: 10 }]}>
            {error}（输入内容已保留）
          </Text>
        )}
        <View style={localStyles.sheetActions}>
          <Button label="先收起" disabled={busy} onPress={() => setComposeOpen(false)} />
          <Button
            primary
            disabled={busy || loading || !canSubmit}
            label={busy ? "正在发布…" : "发布动态"}
            onPress={() =>
              void mutate(
                () => client.publish(viewer, draft, draftKey.current),
                () => {
                  setDraft("");
                  draftKey.current = communityRequestKey();
                  setComposeOpen(false);
                },
                "发帖",
              )
            }
          />
        </View>
      </BottomSheet>

      {/* Block / Delete Confirmation Sheet */}
      <BottomSheet
        visible={Boolean(blockTarget || deleteTarget)}
        title={blockTarget ? "屏蔽对方" : "删除内容"}
        onClose={closeConfirmation}
      >
        {blockTarget && (
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
                  void mutate(() => client.block(viewer, target.id, true, communityRequestKey())).then((ok) => {
                    if (ok && active.current) navigate({ type: "blocks" });
                  });
                }}
              />
            </View>
          </>
        )}
        {deleteTarget && (
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
                  void mutate(() => client.remove(viewer, target.kind, target.id, communityRequestKey())).then((ok) => {
                    if (!ok || !active.current) return;
                    setDeleteTarget(undefined);
                    if (target.kind === "posts" && page.type === "detail") navigate({ type: "feed" });
                  });
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

      {followDirection && (
        <CommunityFollowList
          client={client}
          viewer={viewer}
          direction={followDirection}
          canFollow={own?.canPublish === true}
          onClose={(changed) => {
            setFollowDirection(undefined);
            if (changed) void load();
          }}
        />
      )}
      {reportTarget && (
        <Modal animationType="slide" onRequestClose={closeReport}>
          <SafeAreaView style={s.page}>
            <ReportForm client={client} viewer={viewer} target={reportTarget} onClose={closeReport} />
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}

const localStyles = StyleSheet.create({
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
    color: PEARL_UI.muted,
  },
  modeTabTextActive: {
    fontSize: 19,
    fontWeight: "700",
    color: PEARL_UI.ink,
  },
  modeTabIndicator: {
    marginTop: 4,
    width: 18,
    height: 3,
    borderRadius: 2,
    backgroundColor: PEARL_UI.accent,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  glassIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  composePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: RADIUS.pill,
    backgroundColor: PEARL_UI.accent,
    shadowColor: "#586B85",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 2,
  },
  composePillText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontWeight: "600",
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  backPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: 36,
    paddingHorizontal: 11,
    borderRadius: RADIUS.pill,
  },
  backText: {
    fontSize: 13,
    fontWeight: "600",
    color: PEARL_UI.ink,
  },
  subTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: PEARL_UI.ink,
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
    color: PEARL_UI.muted,
    marginTop: 4,
  },
  noticePill: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PEARL_UI.line,
  },
  emptyCard: {
    paddingVertical: 32,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.68)",
    borderWidth: 1,
    borderColor: PEARL_UI.highlight,
    alignItems: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    color: PEARL_UI.muted,
    textAlign: "center",
    lineHeight: 20,
  },
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
});
