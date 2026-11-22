import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { AgentDraft, CommunityPost } from "../../../contracts/community.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api.ts";
import type { AgentViewer, CommunityClient } from "./client.ts";
import { CommunityButton as Button, communityStyles as s } from "./components.tsx";
import { CommunityRequestScope } from "./request-scope.ts";

export function AgentDraftsScreen({ client, viewer }: { client: CommunityClient; viewer: AgentViewer }) {
  const [items, setItems] = useState<AgentDraft[]>();
  const [previews, setPreviews] = useState<Record<string, CommunityPost | null>>({});
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string>();
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const pending = useRef(false);
  const active = useRef(false);
  const scope = useMemo(() => new CommunityRequestScope(), []);

  const load = useCallback(async () => {
    const current = scope.begin();
    setLoading(true);
    setLoadError("");
    try {
      const { items: next } = await client.agentDrafts(viewer);
      if (!current()) return;
      setItems(next);
      setPreviews({});
      const ids = new Set(next.flatMap(draft => draft.kind === "COMMENT" && draft.postId ? [draft.postId] : []));
      for (const id of ids) {
        void client.detail(viewer, id).then(detail => detail.post, () => null).then(post => {
          if (current()) setPreviews(previous => ({ ...previous, [id]: post }));
        });
      }
      return next;
    } catch (error) {
      if (current()) setLoadError(safeClientMessage(error).title);
    } finally {
      if (current()) setLoading(false);
    }
  }, [client, scope, viewer.kind, viewer.id]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; scope.invalidate(); };
  }, [scope, load]);

  async function decide(draft: AgentDraft, publish: boolean) {
    if (loading || pending.current) return;
    pending.current = true;
    setActingOn(draft.id);
    setMessage("");
    try {
      if (publish) await client.publishAgentDraft(viewer, draft.id);
      else await client.discardAgentDraft(viewer, draft.id);
      if (!active.current) return;
      setItems(current => current?.filter(item => item.id !== draft.id));
      setMessage(publish ? "草稿已发布。" : "草稿已丢弃。");
      await load();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiProblemError && error.status === 404) {
        const latest = await load();
        if (!active.current) return;
        setMessage(!latest ? "暂时无法确认草稿状态，请刷新后再试。"
          : !latest.some(item => item.id === draft.id) ? "这条草稿已不在待处理列表。"
          : publish ? "发布目标或原帖不可用，草稿已保留。" : "暂时无法丢弃草稿，草稿已保留。");
      } else if (error instanceof ApiProblemError && error.status === 403) {
        setMessage("当前操作未获允许。请检查家机公开身份和权限，草稿已保留。");
      } else if (error instanceof ApiProblemError && error.status === 409 && error.code === "INVALID_STATE") {
        setMessage("当前发布过于频繁，请稍后重试。草稿已保留。");
      } else {
        setMessage("暂时无法确认操作结果，请刷新列表。");
        await load();
      }
    } finally {
      pending.current = false;
      if (active.current) setActingOn(undefined);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.title}>草稿箱</Text>
    {loading && <ActivityIndicator accessibilityLabel="正在加载草稿" />}
    {message !== "" && <Text accessibilityRole="alert" style={s.body}>{message}</Text>}
    {loadError !== "" && <Text accessibilityRole="alert" style={s.error}>{loadError}</Text>}
    {!loading && items?.length === 0 && <Text style={s.meta}>暂无待处理草稿。</Text>}
    <Button label="刷新草稿" disabled={loading || actingOn !== undefined} onPress={() => { setMessage(""); void load(); }} />
    {items?.map(draft => {
      const post = draft.postId ? previews[draft.postId] : null;
      return <View key={draft.id} style={s.card}>
        <Text style={s.meta}>{draft.kind === "POST" ? "发帖草稿" : "评论草稿"} · {new Date(draft.createdAt).toLocaleString()}</Text>
        {draft.kind === "COMMENT" && (post
          ? <Text style={s.meta} numberOfLines={3}>原帖 · {post.author.displayName}　{post.body}</Text>
          : <Text style={s.meta}>{post === null ? "原帖不可用" : "正在加载原帖…"}</Text>)}
        <Text selectable style={s.body}>{draft.body}</Text>
        {actingOn === draft.id && <Text style={s.meta}>正在处理…</Text>}
        <View style={s.row}>
          <Button label="发布草稿" disabled={loading || actingOn !== undefined} onPress={() => void decide(draft, true)} />
          <Button label="丢弃草稿" disabled={loading || actingOn !== undefined} onPress={() => void decide(draft, false)} />
        </View>
      </View>;
    })}
  </ScrollView>;
}
