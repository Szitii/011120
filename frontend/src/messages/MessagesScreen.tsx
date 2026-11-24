import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Chat } from "../../../contracts/chat";
import type { ActorContext, CommunityNotification } from "../../../contracts/community";
import { safeClientMessage } from "../adapters/real-api";
import type { ChatClient } from "../chat/client";
import { ActorLine, CommunityButton as Button, SecondaryHeading, useCommunityStyles } from "../community/components";
import { communityRequestKey, type CommunityClient } from "../community/client";
import type { ClientApi, LifeEventInboxCollection, LifeEventInboxItem, OwnerCompanionSummary } from "../contracts";
import type { CommunityTarget } from "../state/navigation";
import { useAppIsActive } from "../state/useAppIsActive";
import { CHROME } from "../theme/layoutTokens";

export function MessagesScreen({ api, viewer, chatClient, companions, visible, onChat, onStartChat, onCreateGroup, onCommunityTarget, onLife, onRead }: {
  api: ClientApi;
  viewer: ActorContext;
  chatClient?: ChatClient;
  companions: OwnerCompanionSummary[];
  visible: boolean;
  onChat: (chat: Chat) => void;
  onStartChat: (companion: OwnerCompanionSummary) => void;
  onCommunityTarget: (target: CommunityTarget) => void;
  onLife: (item: LifeEventInboxItem) => void;
  onRead: () => void;
  onCreateGroup?: () => void;
}) {
  const s = useCommunityStyles();
  const [section, setSection] = useState<"chats" | "notices">(chatClient ? "chats" : "notices");
  const [source, setSource] = useState<"community" | "owner">("community");
  const appActive = useAppIsActive();
  const active = visible && appActive;

  return <View style={s.page}>
    <View style={styles.heading}>
      <SecondaryHeading title="消息" />
      {chatClient && <View style={s.row}>
        <Button label="会话" selected={section === "chats"} onPress={() => setSection("chats")} />
        <Button label="通知" selected={section === "notices"} onPress={() => setSection("notices")} />
      </View>}
      {section === "notices" && viewer.kind === "OWNER" && <View style={s.row}>
        <Button label="社区通知" selected={source === "community"} onPress={() => setSource("community")} />
        <Button label="主人通知" selected={source === "owner"} onPress={() => setSource("owner")} />
      </View>}
    </View>
    {section === "chats" && chatClient && <ConversationList
      client={chatClient} companions={companions} active={active} onChat={onChat} onStartChat={onStartChat} onCreateGroup={onCreateGroup}
    />}
    {section === "notices" && source === "community" && (api.community
      ? <CommunityNotices client={api.community} viewer={viewer} visible={active} onOpen={onCommunityTarget} onRead={onRead} />
      : <Text style={[s.meta, styles.heading]}>连接社区后可以查看通知。</Text>)}
    {section === "notices" && source === "owner" && viewer.kind === "OWNER" &&
      <OwnerNotices api={api} visible={active} onOpen={onLife} onRead={onRead} companions={companions} />}
  </View>;
}

function ConversationList({ client, companions, active, onChat, onStartChat, onCreateGroup }: {
  client: ChatClient;
  companions: OwnerCompanionSummary[];
  active: boolean;
  onChat: (chat: Chat) => void;
  onStartChat: (companion: OwnerCompanionSummary) => void;
  onCreateGroup?: () => void;
}) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<Chat[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError("");
    void client.listChats().then(page => {
      if (current) setItems(page.items);
    }).catch(error => {
      if (current) setError(safeClientMessage(error).title);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, active, reload]);

  const linked = new Set(items?.filter(chat => chat.direct).flatMap(chat => chat.members.map(member => member.companionId)));
  const available = items ? companions.filter(companion => !linked.has(companion.companionId)) : [];

  return <ScrollView contentContainerStyle={styles.content}>
    <Button label="刷新" disabled={loading} onPress={() => setReload(value => value + 1)} />
    {onCreateGroup && companions.length >= 2 && <Button label="新建群聊" primary onPress={onCreateGroup} />}
    {error !== "" && <Text accessibilityRole="alert" style={s.meta}>{error}</Text>}
    {!items && !error && <ActivityIndicator accessibilityLabel="正在读取会话" />}
    {items?.map(chat => {
      const title = chat.title ?? (chat.members.map(member => member.displayName).join("、") || "会话");
      const last = chat.lastMessage;
      const preview = last?.action ? "小家互动" : last?.status === "SENT" && last.body ? last.body : "打开会话";
      return <Pressable key={chat.id} style={s.card} accessibilityRole="button" onPress={() => onChat(chat)}>
        <Text style={s.author} numberOfLines={2}>{title}{chat.direct ? "" : " · 群聊"}{chat.unreadCount ? ` · ${chat.unreadCount} 条未读` : ""}</Text>
        <Text style={s.meta} numberOfLines={1}>{preview}</Text>
      </Pressable>;
    })}
    {available.map(companion => <Button key={companion.companionId}
      label={`和 ${companion.displayName} 聊聊`} onPress={() => onStartChat(companion)} />)}
    {items?.length === 0 && available.length === 0 && <Text style={s.meta}>还没有会话。</Text>}
  </ScrollView>;
}

function CommunityNotices({ client, viewer, visible, onOpen, onRead }: {
  client: CommunityClient; viewer: ActorContext; visible: boolean; onOpen: (target: CommunityTarget) => void; onRead: () => void;
}) {
  const load = useCallback((cursor?: string) => client.notifications(viewer, cursor), [client, viewer.kind, viewer.id]);
  const acknowledge = async (note: CommunityNotification) => {
    await client.readNotification(viewer, note.id, communityRequestKey());
    onRead();
    return { ...note, readAt: new Date().toISOString() };
  };

  return <NoticeList load={load} acknowledge={acknowledge} visible={visible}
    onOpen={note => onOpen(note.postId ? { type: "detail", id: note.postId } : { type: "profile", id: note.actor.id })}
    renderSummary={note => <ActorLine actor={note.actor}
      subtitle={note.kind === "FOLLOW" ? "关注了你" : "评论了你的动态"} />}
  />;
}

function OwnerNotices({ api, visible, onOpen, onRead, companions }: {
  api: ClientApi; visible: boolean; onOpen: (item: LifeEventInboxItem) => void;
  onRead: () => void; companions: OwnerCompanionSummary[];
}) {
  const s = useCommunityStyles();
  type Cursor = NonNullable<LifeEventInboxCollection["nextCursor"]>;
  const load = useCallback((cursor?: Cursor) => api.lifeEventInbox(cursor), [api]);
  return <NoticeList load={load} acknowledge={async (item: LifeEventInboxItem) => {
    const value = await api.acknowledgeLifeEvent(item.id);
    onRead();
    return value;
  }} visible={visible} onOpen={onOpen} renderSummary={item => {
    const isDraft = item.kind === "AGENT_DRAFT" || item.linkedObject?.type === "AGENT_DRAFT";
    const name = isDraft ? companions.find(c => c.companionId === item.companionId)?.displayName : undefined;
    return <Text style={s.author}>{name && !item.title.startsWith(name) ? `${name} · ${item.title}` : item.title}</Text>;
  }} />;
}

function NoticeList<T extends { id: string; readAt?: string | null }, Cursor>({ load, acknowledge, renderSummary, visible, onOpen }: {
  load: (cursor?: Cursor) => Promise<{ items: T[]; nextCursor: Cursor | null }>;
  acknowledge: (item: T) => Promise<T>;
  renderSummary: (item: T) => ReactNode;
  visible: boolean;
  onOpen: (item: T) => void;
}) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<T[]>();
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const openAllowed = useRef(visible);
  openAllowed.current = visible;

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setError(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function read(next?: Cursor) {
    return run(async () => {
      const page = await load(next);
      if (!mounted.current) return;
      setItems(current => {
        const merged = new Map((next === undefined ? [] : (current ?? [])).map(item => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setCursor(page.nextCursor);
    });
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (visible) void read();
  }, [load, visible]);

  function act(item: T, open = false) {
    return run(async () => {
      if (open && openAllowed.current) onOpen(item);
      const next = item.readAt ? item : await acknowledge(item);
      if (!mounted.current) return;
      setItems(current => current?.map(value => value.id === item.id ? next : value));
    });
  }

  return <ScrollView contentContainerStyle={styles.content}>
    <Button label="刷新通知" disabled={busy} onPress={() => void read()} />
    {error !== "" && <Text accessibilityRole="alert" style={s.meta}>{error}</Text>}
    {!items && !error && <ActivityIndicator accessibilityLabel="正在读取通知" />}
    {items?.length === 0 && <Text style={s.meta}>暂时没有通知。</Text>}
    {items?.map(item => <View key={item.id} style={s.card}>
      {renderSummary(item)}
      <View style={s.row}>
        <Text style={s.meta}>{item.readAt ? "已读" : "未读"}</Text>
        <Button label="查看" disabled={busy} onPress={() => void act(item, true)} />
        {!item.readAt && <Button label="标为已读" disabled={busy} onPress={() => void act(item)} />}
      </View>
    </View>)}
    {cursor !== null && <Button label="加载更多" disabled={busy} onPress={() => void read(cursor)} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  heading: { paddingHorizontal: CHROME.screenInset, paddingBottom: 8, gap: 9 },
  content: { paddingHorizontal: CHROME.screenInset, paddingBottom: CHROME.scrollBottomClearance, gap: 10 },
});
