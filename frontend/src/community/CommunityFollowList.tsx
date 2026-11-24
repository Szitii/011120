import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import type { ActorContext, CommunityFollow, CommunityPage } from "../../../contracts/community";
import { communityWriteMessage } from "../adapters/real-api";
import { communityRequestKey, type CommunityClient } from "./client";
import { ActorLine, CommunityButton, SecondaryHeading, useCommunityStyles } from "./components";

export type FollowDirection = "following" | "followers";

export function CommunityFollowList({ client, viewer, direction, onActor, onChanged }: {
  client: CommunityClient;
  viewer: ActorContext;
  direction: FollowDirection;
  onActor: (id: string) => void;
  onChanged: () => void;
}) {
  const s = useCommunityStyles();
  const [page, setPage] = useState<CommunityPage<CommunityFollow>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);

  const run = useCallback(async (cursor?: string, unfollowId?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (unfollowId) {
        await client.follow(viewer, unfollowId, false, communityRequestKey());
        if (mounted.current) {
          setPage(current => current && { ...current, items: current.items.filter(row => row.actor.id !== unfollowId) });
          onChanged();
        }
      }
      const next = await client[direction](viewer, cursor);
      if (!mounted.current) return;
      setPage(previous => {
        if (!cursor || !previous) return next;
        const byId = new Map([...previous.items, ...next.items].map(row => [row.actor.id, row]));
        return { ...next, items: [...byId.values()] };
      });
    } catch (problem) {
      if (mounted.current) setError(communityWriteMessage(problem, viewer.kind, unfollowId ? "取关" : undefined));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [client, direction, viewer.kind, viewer.id, onChanged]);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => { mounted.current = false; };
  }, [run]);

  return <FlatList style={s.page} contentContainerStyle={s.content}
    data={page?.items} keyExtractor={item => item.actor.id}
    refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void run()} />}
    onEndReached={() => { if (page?.nextCursor) void run(page.nextCursor); }}
    ListHeaderComponent={<View>
      <SecondaryHeading title={direction === "following" ? "关注" : "粉丝"} />
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    </View>}
    ListEmptyComponent={!busy && !error ? <View style={s.card}><Text style={s.body}>
      {direction === "following" ? "还没有关注任何人。" : "这里还没有粉丝。"}
    </Text></View> : undefined}
    renderItem={({ item: { actor } }) => <View style={s.card}>
      <View style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}>
        <View style={{ flex: 1 }}>
          <ActorLine actor={actor} onPress={() => onActor(actor.id)} subtitle={actor.bio || `@${actor.handle}`} />
        </View>
        {direction === "following" && <CommunityButton label="取消关注" disabled={busy} onPress={() => void run(undefined, actor.id)} />}
      </View>
    </View>}
  />;
}
