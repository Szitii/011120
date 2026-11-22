import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { ActorContext, CommunityFollow, CommunityPage } from "../../../contracts/community.ts";
import { ApiProblemError, communityWriteMessage, type CommunityWriteAction } from "../adapters/real-api.ts";
import { communityRequestKey, type CommunityClient } from "./client.ts";
import { CommunityButton as Button, SecondaryHeading, communityStyles as s } from "./components.tsx";
import { CommunityRequestScope } from "./request-scope.ts";

export type FollowDirection = "following" | "followers";

export function CommunityFollowList({ client, viewer, direction, canFollow, onClose }: {
  client: CommunityClient;
  viewer: ActorContext;
  direction: FollowDirection;
  canFollow: boolean;
  onClose: (changed: boolean) => void;
}) {
  const [page, setPage] = useState<CommunityPage<CommunityFollow>>();
  const [selected, setSelected] = useState<{ id: string; following: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const changed = useRef(false);
  const scope = useMemo(() => new CommunityRequestScope(), []);
  const fetchPage = useCallback((cursor?: string) => client[direction](viewer, cursor),
    [client, direction, viewer.kind, viewer.id]);

  const run = useCallback(async (work: (current: () => boolean) => Promise<void>, write?: CommunityWriteAction) => {
    if (pending.current) return;
    pending.current = true;
    const current = scope.begin();
    setBusy(true);
    setError("");
    try {
      await work(current);
    } catch (error) {
      if (current()) {
        setError(communityWriteMessage(error, viewer.kind, write));
      }
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [scope, viewer.kind]);

  const load = useCallback((cursor?: string) => run(async current => {
    const next = await fetchPage(cursor);
    if (!current()) return;
    setPage(previous => {
      if (!cursor || !previous) return next;
      const known = new Set(previous.items.map(row => row.actor.id));
      return { ...next, items: [...previous.items, ...next.items.filter(row => !known.has(row.actor.id))] };
    });
  }), [fetchPage, run]);

  useEffect(() => {
    void load();
    return () => { scope.invalidate(); pending.current = false; };
  }, [scope, load]);

  const showRelationship = (id: string) => run(async current => {
    setSelected(undefined);
    try {
      const profile = await client.profile(viewer, id);
      if (current()) setSelected({ id, following: profile.following });
    } catch (error) {
      if (!(error instanceof ApiProblemError) || error.status !== 404) throw error;
      if (!current()) return;
      const latest = await fetchPage();
      if (current()) {
        setPage(latest);
        setError("对方主页已不可用，列表已刷新。");
      }
    }
  });

  const change = (id: string, following: boolean) => run(async current => {
    let unavailable = false;
    try {
      await client.follow(viewer, id, following, communityRequestKey());
      if (!current()) return;
      changed.current = true;
    } catch (error) {
      if (!(error instanceof ApiProblemError) || error.status !== 404) throw error;
      unavailable = true;
    }
    if (!current()) return;
    setSelected(undefined);
    const latest = await fetchPage();
    if (current()) {
      setPage(latest);
      if (unavailable) setError("对方主页已不可用，列表已刷新。");
    }
  }, following ? "关注" : "取关");

  function close() {
    if (!pending.current) onClose(changed.current);
  }

  return <Modal animationType="slide" onRequestClose={close}>
    <SafeAreaView style={s.page}>
      <ScrollView contentContainerStyle={s.content}>
        <SecondaryHeading title={direction === "following" ? "关注列表" : "粉丝列表"} />
        <View style={s.row}>
          <Button glass label="返回主页" disabled={busy} onPress={close} />
          <Button glass label="刷新列表" disabled={busy} onPress={() => { setSelected(undefined); void load(); }} />
        </View>
        {busy && <ActivityIndicator accessibilityLabel="正在加载关注关系" />}
        {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
        {!busy && page?.items.length === 0 && <Text style={s.meta}>暂无可见的{direction === "following" ? "关注" : "粉丝"}。</Text>}
        {page?.items.map(({ actor, since }) => {
          const relationship = selected?.id === actor.id ? selected : undefined;
          return <View key={actor.id} style={s.card}>
            <Text style={s.author}>{actor.displayName}</Text>
            <Text style={s.meta}>@{actor.handle} · {actor.kind === "AI" ? "家机" : "人类"}</Text>
            <Text style={s.meta}>{new Date(since).toLocaleDateString()}</Text>
            <View style={s.row}>
              {direction === "following" || relationship?.following
                ? <Button label={`取消关注 ${actor.displayName}`} disabled={busy} onPress={() => void change(actor.id, false)} />
                : relationship
                  ? <Button label={`关注 ${actor.displayName}`} disabled={busy || !canFollow} onPress={() => void change(actor.id, true)} />
                  : <Button label={`查看与 ${actor.displayName} 的关注状态`} disabled={busy} onPress={() => void showRelationship(actor.id)} />}
            </View>
            {relationship && !relationship.following && !canFollow && <Text style={s.meta}>当前身份暂不能关注对方。</Text>}
          </View>;
        })}
        {page?.nextCursor && <Button label="加载更多" disabled={busy} onPress={() => void load(page.nextCursor ?? undefined)} />}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
