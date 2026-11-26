import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Chat } from "../../../contracts/chat";
import type { ActorContext, CommunityNotification } from "../../../contracts/community";
import { safeClientMessage } from "../adapters/real-api";
import { formatChatAction } from "../chat/actions";
import type { ChatClient } from "../chat/client";
import { ActorLine, CommunityButton as Button, useCommunityStyles } from "../community/components";
import { communityRequestKey, type CommunityClient } from "../community/client";
import { PixelAvatar } from "../components/PixelAvatar";
import type { ClientApi, LifeEventInboxCollection, LifeEventInboxItem, OwnerCompanionSummary } from "../contracts";
import type { CommunityTarget } from "../state/navigation";
import { useAppIsActive } from "../state/useAppIsActive";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

function formatShortTime(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function MessagesScreen({ api, viewer, chatClient, companions, visible, onChat, onStartChat, onOpenCompanionProfile, onCreateGroup, onCommunityTarget, onLife, onRead }: {
  api: ClientApi;
  viewer: ActorContext;
  chatClient?: ChatClient;
  companions: OwnerCompanionSummary[];
  visible: boolean;
  onChat: (chat: Chat) => void;
  onStartChat: (companion: OwnerCompanionSummary) => void;
  onOpenCompanionProfile?: (companionId: string, chatId?: string) => void;
  onCommunityTarget: (target: CommunityTarget) => void;
  onLife: (item: LifeEventInboxItem) => void;
  onRead: () => void;
  onCreateGroup?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [section, setSection] = useState<"chats" | "notices">(chatClient ? "chats" : "notices");
  const [source, setSource] = useState<"community" | "owner">("community");
  const appActive = useAppIsActive();
  const active = visible && appActive;

  return (
    <View style={styles.page}>
      <View style={styles.topBar}>
        <Text accessibilityRole="header" style={styles.title}>消息</Text>
        {chatClient && (
          <View style={styles.segmentWrap}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: section === "chats" }}
              onPress={() => setSection("chats")}
              style={[styles.segmentBtn, section === "chats" && styles.segmentBtnActive]}
            >
              <Text style={[styles.segmentText, section === "chats" && styles.segmentTextActive]}>会话</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: section === "notices" }}
              onPress={() => setSection("notices")}
              style={[styles.segmentBtn, section === "notices" && styles.segmentBtnActive]}
            >
              <Text style={[styles.segmentText, section === "notices" && styles.segmentTextActive]}>通知</Text>
            </Pressable>
          </View>
        )}
      </View>

      {section === "notices" && viewer.kind === "OWNER" && (
        <View style={styles.subTabs}>
          <Button label="社区通知" selected={source === "community"} onPress={() => setSource("community")} />
          <Button label="主人通知" selected={source === "owner"} onPress={() => setSource("owner")} />
        </View>
      )}

      {section === "chats" && chatClient && (
        <ConversationList
          client={chatClient}
          companions={companions}
          active={active}
          onChat={onChat}
          onStartChat={onStartChat}
          onOpenCompanionProfile={onOpenCompanionProfile}
          onCreateGroup={onCreateGroup}
        />
      )}
      {section === "notices" && source === "community" && (
        api.community
          ? <CommunityNotices client={api.community} viewer={viewer} visible={active} onOpen={onCommunityTarget} onRead={onRead} />
          : <Text style={styles.emptyText}>连接社区后可以查看通知。</Text>
      )}
      {section === "notices" && source === "owner" && viewer.kind === "OWNER" && (
        <OwnerNotices api={api} visible={active} onOpen={onLife} onRead={onRead} companions={companions} />
      )}
    </View>
  );
}

function ConversationList({ client, companions, active, onChat, onStartChat, onOpenCompanionProfile, onCreateGroup }: {
  client: ChatClient;
  companions: OwnerCompanionSummary[];
  active: boolean;
  onChat: (chat: Chat) => void;
  onStartChat: (companion: OwnerCompanionSummary) => void;
  onOpenCompanionProfile?: (companionId: string, chatId?: string) => void;
  onCreateGroup?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<Chat[]>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError("");
    void client.listChats().then(page => {
      if (current) setItems(page.items);
    }).catch(err => {
      if (current) setError(safeClientMessage(err).title);
    }).finally(() => {
      if (current) {
        setLoading(false);
        setRefreshing(false);
      }
    });
    return () => { current = false; };
  }, [client, active, reload]);

  const linked = new Set(items?.filter(chat => chat.direct).flatMap(chat => chat.members.map(member => member.companionId)));
  const available = items ? companions.filter(companion => !linked.has(companion.companionId)) : [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={ui.accent}
          onRefresh={() => {
            setRefreshing(true);
            setReload(value => value + 1);
          }}
        />
      }
    >
      {onCreateGroup && companions.length >= 2 && (
        <View style={styles.groupActionRow}>
          <Button label="新建群聊" primary onPress={onCreateGroup} />
        </View>
      )}
      {error !== "" && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
      {!items && !error && loading && <ActivityIndicator accessibilityLabel="正在读取会话" color={ui.accent} style={{ marginVertical: 20 }} />}

      {items && items.length > 0 && (
        <View style={styles.listCard}>
          {items.map((chat, index) => {
            const title = chat.title ?? (chat.members.map(member => member.displayName).join("、") || "会话");
            const last = chat.lastMessage;
            const preview = last?.action
              ? formatChatAction(last.action, last.companionId)
              : last?.status === "SENT" && last.body
                ? last.body
                : "轻点开始聊聊";
            const timeStr = formatShortTime(last?.sentAt ?? chat.activeAt);
            const hasUnread = Boolean(chat.unreadCount && chat.unreadCount > 0);
            const member = chat.direct ? chat.members[0] : undefined;
            const openChat = () => onChat(chat);
            const openProfile = member && onOpenCompanionProfile
              ? () => onOpenCompanionProfile(member.companionId, chat.id)
              : undefined;
            return (
              <View key={chat.id} style={[styles.chatRow, index < items.length - 1 && styles.chatRowDivider]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={openProfile ? `查看 ${title} 的主页` : `打开 ${title} 的会话`}
                  onPress={openProfile ?? openChat}
                  style={styles.avatarWrap}
                  hitSlop={4}
                >
                  <PixelAvatar name={title} role="companion" uri={member?.avatar} size={46} />
                  {hasUnread && <View style={styles.unreadDot} />}
                </Pressable>
                <View style={styles.chatMain}>
                  <View style={styles.chatHeaderRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={openProfile ? `查看 ${title} 的主页` : `打开 ${title} 的会话`}
                      onPress={openProfile ?? openChat}
                      style={styles.chatTitlePress}
                    >
                      <Text style={styles.chatTitle} numberOfLines={1}>
                        {title}{chat.direct ? "" : " · 群聊"}
                      </Text>
                    </Pressable>
                    {!!timeStr && (
                      <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${title} 的会话`} onPress={openChat}>
                        <Text style={styles.chatTime}>{timeStr}</Text>
                      </Pressable>
                    )}
                  </View>
                  <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${title} 的会话`} onPress={openChat}
                    style={({ pressed }) => pressed && styles.chatMainPressed}>
                    <View style={styles.chatFooterRow}>
                      <Text style={styles.chatPreview} numberOfLines={1}>{preview}</Text>
                      {hasUnread && (
                        <View style={styles.unreadPill}>
                          <Text style={styles.unreadCount}>
                            {(chat.unreadCount ?? 0) > 99 ? "99+" : chat.unreadCount}
                          </Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {available.length > 0 && (
        <View style={styles.startSection}>
          <Text style={styles.sectionHint}>开始新对话</Text>
          <View style={styles.listCard}>
            {available.map((companion, index) => {
              const startChat = () => onStartChat(companion);
              const openProfile = onOpenCompanionProfile ? () => onOpenCompanionProfile(companion.companionId) : undefined;
              return (
                <View key={companion.companionId} style={[styles.chatRow, index < available.length - 1 && styles.chatRowDivider]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={openProfile ? `查看 ${companion.displayName} 的主页` : `与 ${companion.displayName} 开始对话`}
                    onPress={openProfile ?? startChat}
                    hitSlop={4}
                  >
                    <PixelAvatar name={companion.displayName} role="companion" uri={companion.avatar} size={44} />
                  </Pressable>
                  <View style={styles.chatMain}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={openProfile ? `查看 ${companion.displayName} 的主页` : `与 ${companion.displayName} 开始对话`}
                      onPress={openProfile ?? startChat}
                      style={styles.chatTitlePress}
                    >
                      <Text style={styles.chatTitle} numberOfLines={1}>{companion.displayName}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`与 ${companion.displayName} 开始对话`} onPress={startChat}
                      style={({ pressed }) => pressed && styles.chatMainPressed}>
                      <Text style={styles.chatPreview}>发第一条消息打个招呼</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {items?.length === 0 && available.length === 0 && (
        <Text style={styles.emptyText}>还没有会话，下滑可刷新。</Text>
      )}
    </ScrollView>
  );
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
    onOpen={note => onOpen(note.postId ? { type: "detail", id: note.postId, commentId: note.commentId ?? undefined }
      : { type: "profile", id: note.actor.id })}
    renderSummary={note => <ActorLine actor={note.actor} subtitle={communityNoticeLabel(note)} />}
  />;
}

function communityNoticeLabel({ kind, commentId }: CommunityNotification) {
  switch (kind) {
    case "FOLLOW": return "关注了你";
    case "COMMENT": return "评论了你的动态";
    case "LIKE": return "赞了你的动态";
    case "MENTION": return commentId ? "在评论中提及了你" : "在动态中提及了你";
    default: return "给你发来一条社区通知";
  }
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
  const { ui } = useSkin();
  const s = useCommunityStyles();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<T[]>();
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
    } catch (err) {
      if (mounted.current) setError(safeClientMessage(err).title);
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        setRefreshing(false);
      }
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

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={ui.accent}
          onRefresh={() => {
            if (pending.current) return;
            setRefreshing(true);
            void read();
          }}
        />
      }
    >
      {error !== "" && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
      {!items && !error && <ActivityIndicator accessibilityLabel="正在读取通知" color={ui.accent} style={{ marginVertical: 20 }} />}
      {items?.length === 0 && <Text style={styles.emptyText}>暂时没有通知，下滑可刷新。</Text>}
      {items?.map(item => (
        <View key={item.id} style={s.card}>
          {renderSummary(item)}
          <View style={s.row}>
            <Text style={s.meta}>{item.readAt ? "已读" : "未读"}</Text>
            <Button label="查看" disabled={busy} onPress={() => void act(item, true)} />
            {!item.readAt && <Button label="标为已读" disabled={busy} onPress={() => void act(item)} />}
          </View>
        </View>
      ))}
      {cursor !== null && <Button label="加载更多" disabled={busy} onPress={() => void read(cursor)} />}
    </ScrollView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  page: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 4,
    paddingBottom: 12,
  },
  title: { fontSize: 24, fontWeight: "800", color: ui.ink },
  segmentWrap: {
    flexDirection: "row",
    backgroundColor: ui.white,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: ui.line,
    padding: 3,
    gap: 2,
  },
  segmentBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
  },
  segmentBtnActive: {
    backgroundColor: ui.accent,
  },
  segmentText: { fontSize: 13, fontWeight: "600", color: ui.muted },
  segmentTextActive: { color: ui.onAccent },
  subTabs: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: CHROME.screenInset,
    paddingBottom: 10,
  },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingBottom: CHROME.scrollBottomClearance + 16,
    gap: 12,
  },
  groupActionRow: { flexDirection: "row", justifyContent: "flex-end" },
  listCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    overflow: "hidden",
  },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  chatRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ui.line,
  },
  avatarWrap: { position: "relative" },
  chatMainPressed: { opacity: 0.72 },
  unreadDot: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ui.accent,
    borderWidth: 2,
    borderColor: ui.white,
  },
  chatMain: { flex: 1, gap: 4 },
  chatTitlePress: { flex: 1 },
  chatHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatTitle: { fontSize: 15.5, fontWeight: "700", color: ui.ink },
  chatTime: { fontSize: 12, color: ui.muted },
  chatFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatPreview: { fontSize: 13.5, color: ui.muted, flex: 1 },
  unreadPill: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadCount: { fontSize: 10.5, fontWeight: "700", color: ui.onAccent },
  startSection: { gap: 8, marginTop: 4 },
  sectionHint: { fontSize: 12.5, fontWeight: "600", color: ui.muted, paddingLeft: 4 },
  emptyText: { fontSize: 13.5, color: ui.muted, textAlign: "center", paddingVertical: 32 },
  errorText: { fontSize: 13, color: ui.danger, textAlign: "center" },
});
