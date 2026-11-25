import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { ActorContext, CommunityActor } from "../../../contracts/community";
import { BottomSheet } from "../components/BottomSheet";
import type { CommunityClient } from "./client";
import { CommunityRequestScope } from "./request-scope";
import { ActorLine, CommunityButton, useCommunityStyles } from "./components";

export const MAX_MENTIONS = 10;
export type Mention = Pick<CommunityActor, "id" | "displayName" | "handle">;

export function MentionChips({ mentions, onRemove, disabled }: {
  mentions: Mention[];
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const s = useCommunityStyles();
  if (!mentions.length) return null;
  return <View style={s.row}>
    <Text style={s.meta}>提及</Text>
    {mentions.map(mention => (
      <CommunityButton key={mention.id} selected label={`@${mention.displayName} ×`}
        accessibilityLabel={`移除提及 ${mention.displayName}（@${mention.handle}）`}
        onPress={() => onRemove(mention.id)} disabled={disabled} />
    ))}
  </View>;
}

export function MentionPicker({ client, viewer, selfId, related = [], selected, onChange, onClose }: {
  client: CommunityClient;
  viewer: ActorContext;
  selfId: string;
  related?: CommunityActor[];
  selected: Mention[];
  onChange: (mentions: Mention[]) => void;
  onClose: () => void;
}) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<CommunityActor[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const scope = useRef(new CommunityRequestScope());

  useEffect(() => {
    const request = scope.current;
    const current = request.begin();
    setLoading(true);
    setError(false);
    void client.following(viewer, next).then(page => {
      if (!current()) return;
      setItems(previous => [...(next ? previous : []), ...page.items.map(item => item.actor)]);
      setCursor(page.nextCursor === next ? null : page.nextCursor);
    }).catch(() => { if (current()) setError(true); })
      .finally(() => { if (current()) setLoading(false); });
    return () => request.invalidate();
  }, [client, viewer.kind, viewer.id, next, reload]);

  const candidates = [...new Map([...related, ...items].map(actor => [actor.id, actor])).values()]
    .filter(actor => actor.id !== selfId);
  const chosen = new Set(selected.map(item => item.id));

  return <BottomSheet visible title="提及谁？" onClose={onClose}>
    <View style={{ gap: 8 }}>
      <Text style={s.meta}>{related.length ? "从当前讨论和关注列表中选择" : "从关注列表中选择"} · {selected.length} / {MAX_MENTIONS}</Text>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 260 }} contentContainerStyle={{ gap: 8 }}>
        {candidates.map(actor => {
          const included = chosen.has(actor.id);
          return <View key={actor.id} style={[s.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1 }}><ActorLine actor={actor} subtitle={`@${actor.handle}`} /></View>
            <CommunityButton label={included ? "移除" : "提及"} selected={included}
              accessibilityLabel={`${included ? "移除提及" : "提及"} ${actor.displayName}（@${actor.handle}）`}
              disabled={!included && selected.length >= MAX_MENTIONS}
              onPress={() => onChange(included ? selected.filter(item => item.id !== actor.id)
                : [...selected, { id: actor.id, displayName: actor.displayName, handle: actor.handle }])} />
          </View>;
        })}
        {loading && <Text style={s.meta}>正在读取关注列表…</Text>}
        {error && <CommunityButton label="关注列表暂时无法读取，重试" onPress={() => setReload(value => value + 1)} />}
        {!loading && !error && candidates.length === 0 && <Text style={s.meta}>暂时没有可提及的人。</Text>}
        {!loading && !error && cursor && <CommunityButton label="加载更多关注" onPress={() => setNext(cursor)} />}
      </ScrollView>
    </View>
  </BottomSheet>;
}
