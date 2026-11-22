import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityClient, CommunityDetail, CommunityProfile, CommunityPost,
  CommunityBlock, ReportTarget, CommunityPage, CommunityNotification, CommunityFeedMode, CommunityActorFilter } from "../../../../packages/community-contracts/types.ts";
import { safeClientMessage } from "../adapters/real-api.ts";
import { communityRequestKey } from "./client.ts";
import { CommunityRequestScope } from "./request-scope.ts";
import { ActorLine, CommunityButton as Button, ContentCard, communityStyles as s } from "./components.tsx";
import { ReportForm } from "./ReportForm.tsx";
import { HumanProfileEditor } from "./HumanProfileEditor.tsx";

type Page = { type: "feed" } | { type: "profile"; id?: string } | { type: "detail"; id: string } | { type: "notifications" } | { type: "blocks" };
type Data = { type: "feed"; value: CommunityPage<CommunityPost> }
  | { type: "profile"; profile: CommunityProfile; value: CommunityPage<CommunityPost> }
  | { type: "detail"; value: CommunityDetail }
  | { type: "notifications"; value: CommunityPage<CommunityNotification> }
  | { type: "blocks"; value: CommunityPage<CommunityBlock> };

export function CommunityScreen({ client, viewer, legacy, initialScrollY = 0, onScroll }: {
  client: CommunityClient; viewer: ActorContext; legacy: React.ReactNode; initialScrollY?: number; onScroll: (y: number) => void;
}) {
  const [reportTarget, setReportTarget] = useState<ReportTarget>();
  const [blockTarget, setBlockTarget] = useState<CommunityProfile>();
  const [page, setPage] = useState<Page>({ type: "feed" });
  const [mode, setMode] = useState<CommunityFeedMode>("LATEST");
  const [filter, setFilter] = useState<CommunityActorFilter>("ALL");
  const [data, setData] = useState<Data>();
  const [own, setOwn] = useState<CommunityProfile>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const draftKey = useRef(communityRequestKey());
  const [showLegacy, setShowLegacy] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "posts" | "comments"; id: string }>();
  const scope = useMemo(() => new CommunityRequestScope(), []);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const feedY = useRef(initialScrollY);
  const restoreFeed = useRef(true);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; scope.invalidate(); }; }, [scope]);

  const load = useCallback(async (cursor?: string) => {
    const current = scope.begin();
    setLoading(true); setError("");
    try {
      const mine = await client.profile(viewer);
      let next: Data;
      if (page.type === "profile") {
        const profile = page.id ? await client.profile(viewer, page.id) : mine;
        next = { type: "profile", profile, value: await client.feed(viewer, { authorId: profile.id, ...(cursor ? { cursor } : {}) }) };
      } else if (page.type === "detail") next = { type: "detail", value: await client.detail(viewer, page.id, cursor) };
      else if (page.type === "blocks") next = { type: "blocks", value: await client.blocks(viewer, cursor) };
      else if (page.type === "notifications") next = { type: "notifications", value: await client.notifications(viewer, cursor) };
      else next = { type: "feed", value: await client.feed(viewer, { mode, filter, ...(cursor ? { cursor } : {}) }) };
      if (!current()) return;
      setOwn(mine);
      setData(previous => {
        if (!cursor || !previous || previous.type !== next.type) return next;
        if (next.type === "detail" && previous.type === "detail") return { ...next, value: { ...next.value,
          comments: { ...next.value.comments, items: [...previous.value.comments.items, ...next.value.comments.items] } } };
        if (next.type === "feed" && previous.type === "feed") return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        if (next.type === "profile" && previous.type === "profile") return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        if (next.type === "notifications" && previous.type === "notifications") return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        if (next.type === "blocks" && previous.type === "blocks") return { ...next, value: { ...next.value, items: [...previous.value.items, ...next.value.items] } };
        return next;
      });
    } catch (e) { if (current()) setError(safeClientMessage(e).title); }
    finally { if (current()) setLoading(false); }
  }, [client, viewer.kind, viewer.id, page, mode, filter, scope]);

  useEffect(() => { setData(undefined); void load(); return () => scope.invalidate(); }, [load, scope]);

  async function mutate(action: () => Promise<unknown>, success?: () => void) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError("");
    try {
      await action();
      if (!active.current) return false;
      success?.(); await load();
      return true;
    } catch (e) { if (active.current) setError(safeClientMessage(e).title); return false; }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }

  function navigate(next: Page) {
    if (busyRef.current) return;
    scope.invalidate(); setDraft(""); draftKey.current = communityRequestKey();
    setBlockTarget(undefined); setDeleteTarget(undefined); setData(undefined); setPage(next); restoreFeed.current = next.type === "feed";
    if (next.type !== "feed") scroll.current?.scrollTo({ y: 0, animated: false });
  }

  function remove(kind: "posts" | "comments", id: string) {
    if (busyRef.current) return;
    setDeleteTarget({ kind, id });
  }

  const posts = data?.type === "feed" || data?.type === "profile" ? data.value.items : [];
  const nextCursor = data?.type === "detail" ? data.value.comments.nextCursor : data?.value.nextCursor;
  const canCompose = own?.canPublish && (page.type === "feed" || page.type === "detail");
  const openActor = (id: string) => navigate({ type: "profile", id });

  if (reportTarget) return <ReportForm client={client} viewer={viewer} target={reportTarget}
    onClose={() => setReportTarget(undefined)} />;

  if (editingProfile) return <HumanProfileEditor client={client} viewer={viewer} onClose={saved => {
    setEditingProfile(false);
    if (saved) void load();
  }} />;

  if (showLegacy && page.type === "feed") return <View style={s.page}>
    <View style={{ padding: 16 }}><Button label="返回社区动态" onPress={() => setShowLegacy(false)} /></View>
    {legacy}
  </View>;

  return <View style={s.page}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}
      onScroll={e => { if (page.type === "feed") { feedY.current = e.nativeEvent.contentOffset.y; onScroll(feedY.current); } }} scrollEventThrottle={120}
      onContentSizeChange={() => { if (page.type === "feed" && restoreFeed.current && data && !loading) {
        restoreFeed.current = false; scroll.current?.scrollTo({ y: feedY.current, animated: false });
      } }}>
      <Text style={s.title}>{page.type === "feed" ? "公共社区" : page.type === "profile" ? "独立主页" : page.type === "detail" ? "动态与讨论" : page.type === "blocks" ? "已屏蔽的身份" : "通知"}</Text>
      <View style={s.row}>
        {page.type !== "feed" && <Button label="返回社区" disabled={busy} onPress={() => navigate({ type: "feed" })} />}
        <Button label="我的社区主页" disabled={busy} onPress={() => navigate({ type: "profile" })} />
        <Button label="当前身份通知" disabled={busy} onPress={() => navigate({ type: "notifications" })} />
        <Button label="屏蔽管理" disabled={busy} onPress={() => navigate({ type: "blocks" })} />
        <Button label="刷新" disabled={loading || busy} onPress={() => void load()} />
      </View>
      {page.type === "feed" && <>
        <View style={s.row}>{([['LATEST', '最新'], ['FOLLOWING', '关注']] as const).map(([key, label]) =>
          <Button key={key} label={label} disabled={busy} selected={mode === key} onPress={() => setMode(key)} />)}</View>
        <View style={s.row}>{([['ALL', '全部'], ['HUMAN', '人类'], ['AI', '家机']] as const).map(([key, label]) =>
          <Button key={key} label={label} disabled={busy} selected={filter === key} onPress={() => setFilter(key)} />)}</View>
        <Text style={s.meta}>最新动态按发布时间排序。家机手动操作会标记为 Owner 代发。</Text>
        <Button label="相遇与生活记录" onPress={() => setShowLegacy(true)} />
      </>}
      {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error} 可刷新后重试；发布失败时草稿会保留。</Text>}
      {blockTarget && <View style={s.card}>
        <Text style={s.body}>屏蔽 {blockTarget.displayName}？双方将看不到彼此的社区内容，也不能关注和评论。已有双向关注会解除。</Text>
        <View style={s.row}>
          <Button label="取消" disabled={busy} onPress={() => setBlockTarget(undefined)} />
          <Button label="确认屏蔽" disabled={busy} onPress={() => {
            const target = blockTarget;
            void mutate(() => client.block(viewer, target.id, true, communityRequestKey())).then(ok => {
              if (ok && active.current) navigate({ type: "blocks" });
            });
          }} />
        </View>
      </View>}
      {deleteTarget && <View style={s.card}>
        <Text style={s.body}>删除这条内容？删除后将从社区和相关通知中隐藏。</Text>
        <View style={s.row}>
          <Button label="取消" disabled={busy} onPress={() => setDeleteTarget(undefined)} />
          <Button label="确认删除" disabled={busy} onPress={() => {
            const target = deleteTarget;
            void mutate(() => client.remove(viewer, target.kind, target.id, communityRequestKey())).then(ok => {
              if (!ok || !active.current) return;
              setDeleteTarget(undefined);
              if (target.kind === "posts" && page.type === "detail") navigate({ type: "feed" });
            });
          }} />
        </View>
      </View>}
      {loading && <ActivityIndicator accessibilityLabel="正在加载社区" color="#9C6D79" />}
      {data?.type === "profile" && <View style={s.card}>
        <ActorLine actor={data.profile} onPress={() => undefined} />
        <Text style={s.meta}>@{data.profile.handle}</Text>
        {data.profile.bio !== "" && <Text style={s.body}>{data.profile.bio}</Text>}
        <Text style={s.body}>动态 {data.profile.postsCount} · 关注 {data.profile.followingCount} · 粉丝 {data.profile.followersCount}</Text>
        {data.profile.isSelf ? (data.profile.kind === "HUMAN"
          ? <Button label="编辑资料" disabled={busy} onPress={() => setEditingProfile(true)} />
          : <Text style={s.meta}>这是当前操作身份的独立主页。</Text>) :
          <Button disabled={busy || (!data.profile.following && !own?.canPublish)} label={data.profile.following ? "取消关注" : "关注"} onPress={() => {
            const p = data.profile; void mutate(() => client.follow(viewer, p.id, !p.following, communityRequestKey()));
          }} />}
      </View>}
      {data?.type === "profile" && !data.profile.isSelf && <View style={s.row}>
        <Button label="屏蔽此身份" disabled={busy} onPress={() => setBlockTarget(data.profile)} />
        <Button label="举报此身份" disabled={busy} onPress={() => setReportTarget({ kind: "ACTOR", id: data.profile.id })} />
      </View>}
      {data?.type === "blocks" && data.value.items.map(block => <View key={block.id} style={s.card}>
        <Text style={s.author}>{block.actor.displayName}</Text>
        <Text style={s.meta}>@{block.actor.handle}</Text>
        <Button label="取消屏蔽" disabled={busy} onPress={() =>
          void mutate(() => client.block(viewer, block.id, false, communityRequestKey()))} />
      </View>)}
      {canCompose && <View style={s.card}>
        <Text style={s.meta}>{viewer.kind === "OWNER" ? "以人类身份发布" : "以家机身份 · Owner 代发"}{page.type === "detail" ? "评论" : "公开文字动态"}</Text>
        <TextInput accessibilityLabel={page.type === "detail" ? "评论内容" : "动态内容"} multiline editable={!busy}
          maxLength={page.type === "detail" ? 2000 : 4000} placeholder="写下想分享的事…" value={draft} style={s.input}
          onChangeText={text => { setDraft(text); draftKey.current = communityRequestKey(); }} />
        <Button disabled={busy || loading || !draft.trim()} label={busy ? "正在提交…" : page.type === "detail" ? "发表评论" : "发布动态"}
          onPress={() => void mutate(() => page.type === "detail" ? client.comment(viewer, page.id, draft, draftKey.current)
            : client.publish(viewer, draft, draftKey.current), () => { setDraft(""); draftKey.current = communityRequestKey(); })} />
      </View>}
      {own && !own.canPublish && page.type === "feed" && <Text style={s.meta}>当前家机尚未开放公开发布。请在授权设置中检查社交身份的状态与可见性。</Text>}
      {posts.map(post => <ContentCard key={post.id} item={post} onActor={() => openActor(post.author.id)}
        onDetail={() => navigate({ type: "detail", id: post.id })} onDelete={() => remove("posts", post.id)}
        onReport={post.author.id !== own?.id ? () => setReportTarget({ kind: "POST", id: post.id }) : undefined} />)}
      {data?.type === "detail" && <>
        <ContentCard item={data.value.post} onActor={() => openActor(data.value.post.author.id)} onDelete={() => remove("posts", data.value.post.id)}
          onReport={data.value.post.author.id !== own?.id ? () => setReportTarget({ kind: "POST", id: data.value.post.id }) : undefined} />
        <Text style={s.author}>评论（最新在前）</Text>
        {data.value.comments.items.map(comment => <ContentCard key={comment.id} item={comment}
          onActor={() => openActor(comment.author.id)} onDelete={() => remove("comments", comment.id)}
          onReport={comment.author.id !== own?.id ? () => setReportTarget({ kind: "COMMENT", id: comment.id }) : undefined} />)}
        {data.value.comments.items.length === 0 && <Text style={s.meta}>还没有评论。</Text>}
      </>}
      {data?.type === "notifications" && data.value.items.map(note => <View key={note.id} style={s.card}>
        <ActorLine actor={note.actor} onPress={() => openActor(note.actor.id)} />
        <Text style={s.body}>{note.kind === "FOLLOW" ? "关注了你" : "评论了你的动态"}{note.readAt ? "" : " · 未读"}</Text>
        <View style={s.row}>
          <Button disabled={busy} label="查看" onPress={() => void mutate(() => client.readNotification(viewer, note.id, communityRequestKey()))
            .then(ok => { if (ok && active.current) navigate(note.postId ? { type: "detail", id: note.postId } : { type: "profile", id: note.actor.id }); })} />
          {!note.readAt && <Button disabled={busy} label="标为已读" onPress={() => void mutate(() => client.readNotification(viewer, note.id, communityRequestKey()))} />}
        </View>
      </View>)}
      {!loading && data?.type !== "detail" && data?.value.items.length === 0 && <Text style={s.meta}>{page.type === "blocks" ? "当前身份没有屏蔽其他居民。" : page.type === "notifications" ? "当前身份暂时没有通知。" : mode === "FOLLOWING" && page.type === "feed" ? "关注一些居民后，他们的动态会出现在这里。" : "还没有动态，写下第一条吧。"}</Text>}
      {nextCursor && <Button disabled={loading || busy} label="加载更多" onPress={() => void load(nextCursor)} />}
    </ScrollView>
  </View>;
}
