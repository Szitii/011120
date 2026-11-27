import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import type { ActorContext, CommunityFollow, CommunityPage } from "../../../contracts/community";
import { ApiProblemError, communityWriteMessage, safeClientMessage } from "../adapters/real-api";
import { communityRequestKey, type CommunityClient } from "./client";
import { ActorLine, CommunityButton, SecondaryHeading, useCommunityStyles } from "./components";

export type FollowDirection = "following" | "followers";

type Operation = { kind: "read"; cursor?: string } | { kind: "write"; targetId: string; key: string };
type ListState = {
  scope: object;
  page?: CommunityPage<CommunityFollow>;
  pending?: Operation;
  failure?: { title: string; retry?: Operation };
};

export function CommunityFollowList({ client, viewer, direction, onActor, onChanged }: {
  client: CommunityClient;
  viewer: ActorContext;
  direction: FollowDirection;
  onActor: (id: string) => void;
  onChanged: () => void;
}) {
  const s = useCommunityStyles();
  const { kind, id } = viewer;
  const scope = useMemo(() => ({ active: false, ticket: undefined as object | undefined }), [client, direction, kind, id]);
  const [list, setList] = useState<ListState>();
  const state = list?.scope === scope ? list : undefined;
  const page = state?.page;
  const failure = state?.failure;
  const pending = state?.pending;

  const run = useCallback(async (operation: Operation = { kind: "read" }) => {
    if (!scope.active || scope.ticket) return;
    const ticket = {};
    scope.ticket = ticket;
    const current = () => scope.active && scope.ticket === ticket;
    const subject = { kind, id };
    setList(previous => ({ scope, page: previous?.scope === scope ? previous.page : undefined, pending: operation }));

    try {
      if (operation.kind === "write") {
        const follow = direction === "followers";
        await client.follow(subject, operation.targetId, follow, operation.key);
        if (!current()) return;
        setList(previous => previous?.page && { scope, page: { ...previous.page, items: follow
          ? previous.page.items.map(row => row.actor.id === operation.targetId ? { ...row, following: true } : row)
          : previous.page.items.filter(row => row.actor.id !== operation.targetId) } });
        onChanged();
      } else {
        const next = await client[direction](subject, operation.cursor);
        if (!current()) return;
        setList(previous => {
          if (!operation.cursor || !previous?.page) return { scope, page: next };
          const items = new Map([...previous.page.items, ...next.items].map(row => [row.actor.id, row]));
          return { scope, page: { items: [...items.values()], nextCursor: next.nextCursor === operation.cursor ? null : next.nextCursor } };
        });
      }
    } catch (problem) {
      if (!current()) return;
      const safe = safeClientMessage(problem);
      const write = operation.kind === "write" ? direction === "followers" ? "关注" : "取关" : undefined;
      const noLongerVisible = !write && problem instanceof ApiProblemError && (problem.status === 401 || problem.status === 403 || problem.status === 404);
      setList(previous => ({
        scope,
        page: noLongerVisible ? undefined : previous?.page,
        failure: { title: write ? communityWriteMessage(problem, kind, write) : safe.title,
          retry: safe.retry ? operation : undefined },
      }));
    } finally {
      if (current()) scope.ticket = undefined;
    }
  }, [client, direction, kind, id, onChanged, scope]);

  useEffect(() => {
    scope.active = true;
    void run();
    return () => {
      scope.active = false;
      scope.ticket = undefined;
    };
  }, [run, scope]);

  return <FlatList style={s.page} contentContainerStyle={s.content}
    data={page?.items} keyExtractor={item => item.actor.id}
    refreshControl={<RefreshControl refreshing={!!page && pending?.kind === "read" && !pending.cursor} onRefresh={() => void run()} />}
    onEndReached={() => {
      if (page?.nextCursor && !failure && !pending) void run({ kind: "read", cursor: page.nextCursor });
    }}
    ListHeaderComponent={<View>
      <SecondaryHeading title={direction === "following" ? "关注" : "粉丝"} />
      {failure && <View style={s.card}>
        <Text accessibilityRole="alert" style={s.error}>{failure.title}</Text>
        {failure.retry && <CommunityButton label="重试" onPress={() => void run(failure.retry)} />}
      </View>}
    </View>}
    ListFooterComponent={pending?.kind === "read" && pending.cursor ? <ActivityIndicator accessibilityLabel="正在加载更多" /> : undefined}
    ListEmptyComponent={!page && !failure ? <ActivityIndicator accessibilityLabel="正在读取列表" />
      : page && !pending && !failure ? <View style={s.card}><Text style={s.body}>
        {direction === "following" ? "还没有关注任何人。" : "这里还没有粉丝。"}
      </Text></View> : undefined}
    renderItem={({ item: { actor, following } }) => <View style={s.card}>
      <View style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <ActorLine actor={actor} onPress={() => onActor(actor.id)} subtitle={actor.bio || `@${actor.handle}`} />
        </View>
        {direction === "following" || !following
          ? <CommunityButton label={direction === "following" ? "取消关注" : "回关"} disabled={!!pending}
            onPress={() => void run({ kind: "write", targetId: actor.id, key: communityRequestKey() })} />
          : <Text style={s.meta}>已互关</Text>}
      </View>
    </View>}
  />;
}
