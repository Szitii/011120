import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Chat } from "../../../contracts/chat";
import type { ActorContext, CommunityNotification } from "../../../contracts/community";
import { safeClientMessage } from "../adapters/real-api";
import { formatChatAction } from "../chat/actions";
import type { ChatClient } from "../chat/client";
import type { ChatDraftStore } from "../chat/draftStore";
import { ActorLine, CommunityButton as Button, useCommunityStyles } from "../community/components";
import { communityRequestKey, type CommunityClient } from "../community/client";
import { PixelAvatar } from "../components/PixelAvatar";
import { BottomSheet } from "../components/BottomSheet";
import type { ClientApi, LifeEventInboxCollection, LifeEventInboxItem, OwnerCompanionSummary } from "../contracts";
import type { CommunityTarget } from "../state/navigation";
import { useAppIsActive } from "../state/useAppIsActive";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

export interface ChatLocalPreference {
  pinned?: boolean;
  muted?: boolean;
}

export type ChatPreferenceMap = Record<string, ChatLocalPreference>;

const EMPTY_CHAT_PREFERENCES: ChatPreferenceMap = {};
const PICKER_MAX_SCREEN_FRACTION = 0.55;
// The list unmounts when switching to notifications. Drain its writes before the next read.
let chatPreferenceWrites = Promise.resolve();

export function chatPrefsStorageKey(ownerId: string): string {
  return `companion:chat-prefs:v1:${ownerId}`;
}

export function parseChatPreferences(raw: string | null): ChatPreferenceMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = (
      "items" in parsed && parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)
        ? parsed.items
        : parsed
    ) as Record<string, unknown>;
    const next: ChatPreferenceMap = {};
    for (const [chatId, value] of Object.entries(record)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const pinned = entry.pinned === true;
      const muted = entry.muted === true;
      if (pinned || muted) {
        next[chatId] = { pinned, muted };
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function serializeChatPreferences(prefs: ChatPreferenceMap): string {
  const cleaned: ChatPreferenceMap = {};
  for (const [chatId, pref] of Object.entries(prefs)) {
    if (pref.pinned || pref.muted) {
      cleaned[chatId] = { pinned: Boolean(pref.pinned), muted: Boolean(pref.muted) };
    }
  }
  return JSON.stringify({ schemaVersion: 1, items: cleaned });
}

export function filterAndSortChats(
  chats: readonly Chat[],
  query: string,
  prefs: ChatPreferenceMap,
): Chat[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized === ""
    ? [...chats]
    : chats.filter(chat => {
        const title = (chat.title ?? "").toLowerCase();
        if (title.includes(normalized)) return true;
        return chat.members.some(member => member.displayName.toLowerCase().includes(normalized));
      });
  return filtered.sort((a, b) => {
    const aPinned = prefs[a.id]?.pinned === true ? 1 : 0;
    const bPinned = prefs[b.id]?.pinned === true ? 1 : 0;
    return bPinned - aPinned;
  });
}

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

export function MessagesScreen({ api, viewer, chatClient, ownerId, draftStore, companions, visible, onChat, onStartChat, onOpenCompanionProfile, onCreateGroup, onCommunityTarget, onLife, onRead }: {
  api: ClientApi;
  viewer: ActorContext;
  chatClient?: ChatClient;
  ownerId?: string;
  draftStore?: ChatDraftStore;
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
          ownerId={ownerId}
          draftStore={draftStore}
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

function ConversationList({ client, ownerId, draftStore, companions, active, onChat, onStartChat, onOpenCompanionProfile, onCreateGroup }: {
  client: ChatClient;
  ownerId?: string;
  draftStore?: ChatDraftStore;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [prefs, setPrefs] = useState<ChatPreferenceMap>(EMPTY_CHAT_PREFERENCES);
  const [menuChat, setMenuChat] = useState<Chat | null>(null);
  const [, bumpDraftRevision] = useState(0);
  const prefsRef = useRef<ChatPreferenceMap | undefined>(undefined);
  const [prefsReady, setPrefsReady] = useState(false);
  const [prefsReadFailed, setPrefsReadFailed] = useState(false);
  const [prefsSaveFailed, setPrefsSaveFailed] = useState(false);
  const [prefsRetry, setPrefsRetry] = useState(0);
  const prefsKey = ownerId ? chatPrefsStorageKey(ownerId) : undefined;
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    prefsRef.current = undefined;
    setPrefs(EMPTY_CHAT_PREFERENCES);
    setPrefsReady(false);
    setPrefsReadFailed(false);
    setPrefsSaveFailed(false);
    if (!prefsKey) return;
    let current = true;
    void chatPreferenceWrites.then(() => AsyncStorage.getItem(prefsKey)).then(raw => {
      if (!current) return;
      const loaded = parseChatPreferences(raw);
      prefsRef.current = loaded;
      setPrefs(loaded);
      setPrefsReady(true);
    }).catch(() => { if (current) setPrefsReadFailed(true); });
    return () => { current = false; };
  }, [prefsKey, prefsRetry]);

  useEffect(() => {
    if (!active || !draftStore?.subscribe) return;
    return draftStore.subscribe(() => {
      bumpDraftRevision(value => value + 1);
    });
  }, [active, draftStore]);

  const saveChatPrefs = useCallback((next: ChatPreferenceMap) => {
    if (!prefsKey) return;
    setPrefsSaveFailed(false);
    const serialized = serializeChatPreferences(next);
    const isEmpty = Object.keys(next).length === 0;
    chatPreferenceWrites = chatPreferenceWrites
      .then(() => isEmpty ? AsyncStorage.removeItem(prefsKey) : AsyncStorage.setItem(prefsKey, serialized))
      .catch(() => { if (prefsRef.current === next) setPrefsSaveFailed(true); });
  }, [prefsKey]);

  const updateChatPref = useCallback((chatId: string, patch: Partial<ChatLocalPreference>) => {
    const current = prefsRef.current;
    if (!current) return;

    const prev = current[chatId];
    const pinned = patch.pinned ?? prev?.pinned ?? false;
    const muted = patch.muted ?? prev?.muted ?? false;
    const next: ChatPreferenceMap = { ...current };
    if (pinned || muted) next[chatId] = { pinned, muted };
    else delete next[chatId];
    prefsRef.current = next;
    setPrefs(next);
    saveChatPrefs(next);
  }, [saveChatPrefs]);

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

  const visibleChats = useMemo(
    () => (items ? filterAndSortChats(items, searchQuery, prefs) : undefined),
    [items, searchQuery, prefs],
  );
  const trimmedQuery = searchQuery.trim();
  const menuTitle = menuChat
    ? menuChat.title ?? (menuChat.members.map(member => member.displayName).join("、") || "会话")
    : "";
  const menuPref = menuChat ? prefs[menuChat.id] : undefined;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
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
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={16} color={ui.muted} />
        <TextInput
          accessibilityLabel="搜索会话"
          placeholder="搜索会话标题或成员"
          placeholderTextColor={ui.placeholder}
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {searchQuery !== "" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空搜索"
            onPress={() => setSearchQuery("")}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={16} color={ui.muted} />
          </Pressable>
        )}
      </View>

      {companions.length > 0 && (
        <View style={styles.groupActionRow}>
          <Button label="发起对话" onPress={() => { Keyboard.dismiss(); setPickerOpen(true); }} />
          {onCreateGroup && companions.length >= 2 && (
            <Button label="新建群聊" primary onPress={onCreateGroup} />
          )}
        </View>
      )}
      {error !== "" && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
      {prefsSaveFailed && <View>
        <Text accessibilityRole="alert" style={styles.errorText}>会话偏好暂未保存。</Text>
        <Button label="重试保存" onPress={() => { if (prefsRef.current) saveChatPrefs(prefsRef.current); }} />
      </View>}
      {!items && !error && loading && <ActivityIndicator accessibilityLabel="正在读取会话" color={ui.accent} style={{ marginVertical: 20 }} />}

      {visibleChats && visibleChats.length > 0 && (
        <View style={styles.listCard}>
          {visibleChats.map((chat, index) => {
            const title = chat.title ?? (chat.members.map(member => member.displayName).join("、") || "会话");
            const last = chat.lastMessage;
            const draft = draftStore?.readByChatId(ownerId, chat.id);
            const draftPreviewText = draft ? draft.text.replace(/\s+/g, " ").trim() : "";
            const hasDraft = Boolean(draft && (draftPreviewText !== "" || draft.mentions.length > 0));
            const fallbackPreview = last?.action
              ? formatChatAction(last.action, last.companionId)
              : last?.status === "SENT" && last.body
                ? last.body
                : "轻点开始聊聊";
            const timeStr = formatShortTime(last?.sentAt ?? chat.activeAt);
            const pref = prefs[chat.id];
            const isPinned = pref?.pinned === true;
            const isMuted = pref?.muted === true;
            const hasUnread = Boolean(chat.unreadCount && chat.unreadCount > 0);
            const member = chat.direct ? chat.members[0] : undefined;
            const openChat = () => onChat(chat);
            const openMenu = () => { Keyboard.dismiss(); setMenuChat(chat); };
            const openProfile = member && onOpenCompanionProfile
              ? () => onOpenCompanionProfile(member.companionId, chat.id)
              : undefined;
            return (
              <View
                key={chat.id}
                style={[
                  styles.chatRow,
                  isPinned && styles.chatRowPinned,
                  index < visibleChats.length - 1 && styles.chatRowDivider,
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={openProfile ? `查看 ${title} 的主页` : `打开 ${title} 的会话`}
                  onPress={openProfile ?? openChat}
                  onLongPress={openMenu}
                  delayLongPress={320}
                  style={styles.avatarWrap}
                  hitSlop={4}
                >
                  <PixelAvatar name={title} role="companion" uri={member?.avatar} size={46} />
                  {hasUnread && <View style={[styles.unreadDot, isMuted && styles.unreadDotMuted]} />}
                </Pressable>
                <View style={styles.chatMain}>
                  <View style={styles.chatHeaderRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={openProfile ? `查看 ${title} 的主页` : `打开 ${title} 的会话`}
                      onPress={openProfile ?? openChat}
                      onLongPress={openMenu}
                      delayLongPress={320}
                      style={styles.chatTitlePress}
                    >
                      <View style={styles.chatTitleWrap}>
                        {isPinned && (
                          <Ionicons
                            name="pin-outline"
                            size={13}
                            color={ui.accentInk}
                            accessibilityLabel="已置顶"
                            style={styles.pinIcon}
                          />
                        )}
                        <Text style={styles.chatTitle} numberOfLines={1}>
                          {title}{chat.direct ? "" : " · 群聊"}
                        </Text>
                      </View>
                    </Pressable>
                    {!!timeStr && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`打开 ${title} 的会话`}
                        onPress={openChat}
                        onLongPress={openMenu}
                        delayLongPress={320}
                      >
                        <Text style={styles.chatTime}>{timeStr}</Text>
                      </Pressable>
                    )}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`打开 ${title} 的会话`}
                    onPress={openChat}
                    onLongPress={openMenu}
                    delayLongPress={320}
                    style={({ pressed }) => pressed && styles.chatMainPressed}
                  >
                    <View style={styles.chatFooterRow}>
                      {hasDraft ? (
                        <Text style={styles.chatPreview} numberOfLines={1}>
                          <Text style={styles.draftTag}>[草稿] </Text>
                          {draftPreviewText || "已提及成员"}
                        </Text>
                      ) : (
                        <Text style={styles.chatPreview} numberOfLines={1}>{fallbackPreview}</Text>
                      )}
                      <View style={styles.chatFooterRight}>
                        {isMuted && (
                          <Ionicons
                            name="notifications-off-outline"
                            size={14}
                            color={ui.muted}
                            accessibilityLabel="已免打扰"
                          />
                        )}
                        {hasUnread && (
                          <View style={[styles.unreadPill, isMuted && styles.unreadPillMuted]}>
                            <Text style={[styles.unreadCount, isMuted && styles.unreadCountMuted]}>
                              {(chat.unreadCount ?? 0) > 99 ? "99+" : chat.unreadCount}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {items && items.length > 0 && visibleChats?.length === 0 && trimmedQuery !== "" && (
        <Text style={styles.emptyText}>未找到匹配的会话。</Text>
      )}

      {items?.length === 0 && (
        <Text style={styles.emptyText}>
          {trimmedQuery !== ""
            ? "暂无可搜索的会话。"
            : companions.length > 0
              ? "还没有会话，点「发起对话」开始。"
              : "还没有会话，下滑可刷新。"}
        </Text>
      )}

      <BottomSheet
        visible={menuChat !== null}
        title={menuTitle}
        onClose={() => setMenuChat(null)}
      >
        {menuChat && !prefsReady && (
          prefsReadFailed
            ? <Button label="重新加载会话偏好" onPress={() => setPrefsRetry(value => value + 1)} />
            : <Text style={styles.menuFootnote}>{prefsKey ? "正在读取会话偏好…" : "当前账号无法保存会话偏好。"}</Text>
        )}
        {menuChat && prefsReady && (
          <View style={styles.menuList}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={menuPref?.pinned ? "取消置顶" : "置顶会话"}
              onPress={() => {
                updateChatPref(menuChat.id, { pinned: !menuPref?.pinned });
                setMenuChat(null);
              }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.chatMainPressed]}
            >
              <Ionicons name="pin-outline" size={18} color={ui.accentInk} />
              <Text style={styles.menuLabel}>{menuPref?.pinned ? "取消置顶" : "置顶会话"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={menuPref?.muted ? "取消免打扰" : "设为免打扰"}
              onPress={() => {
                updateChatPref(menuChat.id, { muted: !menuPref?.muted });
                setMenuChat(null);
              }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.chatMainPressed]}
            >
              <Ionicons
                name={menuPref?.muted ? "notifications-outline" : "notifications-off-outline"}
                size={18}
                color={ui.accentInk}
              />
              <Text style={styles.menuLabel}>{menuPref?.muted ? "取消免打扰" : "设为免打扰"}</Text>
            </Pressable>
            <Text style={styles.menuFootnote}>设置仅保存在当前设备。免打扰会淡化会话未读提示。</Text>
          </View>
        )}
      </BottomSheet>

      <BottomSheet visible={pickerOpen} title="发起新对话" onClose={() => setPickerOpen(false)}>
        <ScrollView style={{ maxHeight: Math.round(windowHeight * PICKER_MAX_SCREEN_FRACTION) }}
          contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
          {companions.map(companion => {
            const openCompanionProfile = onOpenCompanionProfile
              ? () => {
                  setPickerOpen(false);
                  onOpenCompanionProfile(companion.companionId);
                }
              : undefined;
            const existingChat = items?.find(chat => chat.direct
              && chat.members.some(member => member.companionId === companion.companionId));
            const openConversation = () => {
              setPickerOpen(false);
              if (existingChat) onChat(existingChat);
              else onStartChat(companion);
            };
            return (
              <View key={companion.companionId} style={styles.pickerRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={openCompanionProfile ? `查看 ${companion.displayName} 的主页` : `与 ${companion.displayName} 开始对话`}
                  onPress={openCompanionProfile ?? openConversation}
                  hitSlop={4}
                >
                  <PixelAvatar name={companion.displayName} role="companion" uri={companion.avatar} size={40} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={existingChat ? `继续与 ${companion.displayName} 的对话` : `与 ${companion.displayName} 开始新对话`}
                  onPress={openConversation}
                  style={({ pressed }) => [styles.pickerMain, pressed && styles.chatMainPressed]}
                >
                  <Text style={styles.pickerName} numberOfLines={1}>{companion.displayName}</Text>
                  <Text style={styles.pickerMeta}>{existingChat ? "已有会话，继续聊" : "还没有会话，发第一条消息"}</Text>
                </Pressable>
                <Ionicons name="chevron-forward" size={15} color={ui.muted} />
              </View>
            );
          })}
        </ScrollView>
      </BottomSheet>
    </ScrollView>
  );
}

function CommunityNotices({ client, viewer, visible, onOpen, onRead }: {
  client: CommunityClient; viewer: ActorContext; visible: boolean; onOpen: (target: CommunityTarget) => void; onRead: () => void;
}) {
  const load = useCallback((cursor?: string) => client.notifications(viewer, cursor), [client, viewer.kind, viewer.id]);
  const acknowledge = async (note: CommunityNotification) => {
    await client.readNotification(viewer, note.id, communityRequestKey());
    return { ...note, readAt: new Date().toISOString() };
  };

  return <NoticeList load={load} acknowledge={acknowledge} onRead={onRead} visible={visible}
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
    return api.acknowledgeLifeEvent(item.id);
  }} onRead={onRead} visible={visible} onOpen={onOpen} renderSummary={item => {
    const isDraft = item.kind === "AGENT_DRAFT" || item.linkedObject?.type === "AGENT_DRAFT";
    const name = isDraft ? companions.find(c => c.companionId === item.companionId)?.displayName : undefined;
    return <Text style={s.author}>{name && !item.title.startsWith(name) ? `${name} · ${item.title}` : item.title}</Text>;
  }} />;
}

function NoticeList<T extends { id: string; readAt?: string | null }, Cursor>({ load, acknowledge, renderSummary, visible, onOpen, onRead }: {
  load: (cursor?: Cursor) => Promise<{ items: T[]; nextCursor: Cursor | null }>;
  acknowledge: (item: T) => Promise<T>;
  renderSummary: (item: T) => ReactNode;
  visible: boolean;
  onOpen: (item: T) => void;
  onRead: () => void;
}) {
  const { ui } = useSkin();
  const s = useCommunityStyles();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<T[]>();
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
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
        setMarkingAll(false);
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
      if (!item.readAt) onRead();
      if (!mounted.current) return;
      setItems(current => current?.map(value => value.id === item.id ? next : value));
    });
  }

  function markAllRead() {
    const unreadItems = items?.filter(item => !item.readAt) ?? [];
    if (unreadItems.length === 0 || pending.current) return;
    setMarkingAll(true);
    return run(async () => {
      let acknowledged = false;
      try {
        for (const target of unreadItems) {
          if (!mounted.current) break;
          const confirmed = await acknowledge(target);
          acknowledged = true;
          if (!mounted.current) break;
          setItems(current => current?.map(value => value.id === target.id ? confirmed : value));
        }
      } finally {
        if (acknowledged) onRead();
      }
    });
  }

  const unreadCount = items ? items.reduce((sum, item) => sum + (item.readAt ? 0 : 1), 0) : 0;

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
      {items && items.length > 0 && (
        <View style={styles.noticeToolbar}>
          <Text style={s.meta}>
            {unreadCount > 0 ? `${unreadCount} 条未读` : "当前列表均已读"}
          </Text>
          <Button
            label={markingAll ? "正在标记…" : "标记已加载通知为已读"}
            accessibilityLabel="标记已加载通知为已读"
            disabled={busy || unreadCount === 0}
            onPress={() => void markAllRead()}
          />
        </View>
      )}
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
  noticeToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingBottom: CHROME.scrollBottomClearance + 16,
    gap: 12,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    color: ui.ink,
  },
  groupActionRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
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
  chatRowPinned: {
    backgroundColor: ui.background[0],
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
  unreadDotMuted: {
    backgroundColor: ui.muted,
  },
  chatMain: { flex: 1, gap: 4 },
  chatTitlePress: { flex: 1 },
  chatTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  pinIcon: {
    transform: [{ rotate: "35deg" }],
  },
  chatHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatTitle: { fontSize: 15.5, fontWeight: "700", color: ui.ink, flexShrink: 1 },
  chatTime: { fontSize: 12, color: ui.muted },
  chatFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatFooterRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chatPreview: { fontSize: 13.5, color: ui.muted, flex: 1 },
  draftTag: { color: ui.accentInk, fontWeight: "600" },
  unreadPill: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadPillMuted: {
    backgroundColor: ui.accentWash,
  },
  unreadCount: { fontSize: 10.5, fontWeight: "700", color: ui.onAccent },
  unreadCountMuted: { color: ui.muted },
  menuList: { gap: 8 },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  menuLabel: { fontSize: 15, fontWeight: "600", color: ui.ink },
  menuFootnote: { fontSize: 12, color: ui.muted, textAlign: "center", paddingTop: 2 },
  pickerList: { gap: 8 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: ui.background[0],
  },
  pickerMain: { flex: 1, gap: 2 },
  pickerName: { fontSize: 15, fontWeight: "600", color: ui.ink },
  pickerMeta: { fontSize: 12, color: ui.muted },
  emptyText: { fontSize: 13.5, color: ui.muted, textAlign: "center", paddingVertical: 32 },
  errorText: { fontSize: 13, color: ui.danger, textAlign: "center" },
});
