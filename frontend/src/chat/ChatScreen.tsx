import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Chat, ChatMessage, ChatSendResult, ChatVoiceInput, Wallet } from "../../../contracts/chat";
import { chatReadTarget, makeIdempotencyKey, type ChatClient } from "./client";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { PixelAvatar } from "../components/PixelAvatar";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import type { QuoteInput } from "../album/store";
import { BottomSheet } from "../components/BottomSheet";
import { CommunityButton } from "../community/components";
import { VoiceComposer } from "./VoiceComposer";
import { quotaMessage } from "../wallet/wallet";
import { useVoicePlayback } from "./useVoicePlayback";
import { useAppIsActive } from "../state/useAppIsActive";
import {
  BUBBLE_SKINS,
  CHAT_BACKGROUNDS,
  loadChatTheme,
  resolveChatThemeStyles,
  saveChatTheme,
  type ChatThemePreference,
} from "../theme/chatThemes";

const QUICK_EMOJIS = ["😊", "🥺", "❤️", "😂", "🫂", "✨", "👍", "🌙", "☕️", "🐶", "😭", "🫶"];

const actionLabels = {
  WAVE: "你向 TA 挥了挥手",
  PAT_HEAD: "你摸了摸 TA 的头",
  HUG: "你抱了抱 TA",
  CUDDLE: "你和 TA 贴了贴",
} satisfies Record<NonNullable<ChatMessage["action"]>, string>;

const replyFailureMessages = {
  UNAVAILABLE: "即将推出",
  DISABLED: "平台模型暂时关闭",
  ERROR: "这条回复没发出来，可以重试",
};

function mergeLatestMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const incomingIds = new Set(incoming.map((m) => m.id));
  const older = existing.filter((m) => !incomingIds.has(m.id));
  return [...incoming.map((m) => byId.get(m.id)!), ...older];
}

export function ChatScreen({
  client,
  initialChatId,
  companionId,
  companionName,
  ownerName,
  ownerAvatar,
  ownerId,
  autoFocus = false,
  backLabel = "返回",
  onBackToHome,
  onSaveQuote,
  onOpenSettings,
  onRead,
  groupSendEnabled,
  onAvailabilityChanged,
}: {
  client: ChatClient;
  initialChatId?: string;
  companionId?: string;
  companionName: string;
  ownerName: string;
  ownerAvatar?: string | null;
  ownerId: string;
  autoFocus?: boolean;
  backLabel?: string;
  onBackToHome: () => void;
  onSaveQuote?: (quote: QuoteInput) => Promise<void>;
  groupSendEnabled: boolean;
  onAvailabilityChanged: () => void;
  onRead?: () => void;
  onOpenSettings?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const { playback, toggle, stop: stopPlayback } = useVoicePlayback();
  const appActive = useAppIsActive();
  const wasActive = useRef(appActive);
  const [chat, setChat] = useState<Chat | null>(null);
  const isGroup = chat?.direct === false;
  const groupReadOnly = isGroup && !groupSendEnabled;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceInput, setVoiceInput] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [tray, setTray] = useState<"none" | "emoji" | "plus">("none");
  const [themePref, setThemePref] = useState<ChatThemePreference>({ bubbleSkin: "default", background: "pearl" });
  const [themeSheetOpen, setThemeSheetOpen] = useState(false);
  const [attachNotice, setAttachNotice] = useState("");

  useEffect(() => {
    if (Platform.OS === "web" || !appActive || !client.sendVoice) { setVoiceInput(false); return; }
    let current = true;
    void client.listVoices?.().then(result => {
      if (current) setVoiceInput(result.input === true);
    }).catch(() => { if (current) setVoiceInput(false); });
    return () => { current = false; };
  }, [appActive, client]);

  useEffect(() => {
    const id = chat?.id ?? initialChatId;
    if (!id) return;
    let current = true;
    void loadChatTheme(ownerId, id).then(pref => { if (current) setThemePref(pref); });
    return () => { current = false; };
  }, [chat?.id, initialChatId, ownerId]);

  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [quote, setQuote] = useState<QuoteInput>();
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteResult, setQuoteResult] = useState("");
  const quotePending = useRef(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const chatIdRef = useRef<string | undefined>(initialChatId);
  const sessionRef = useRef(0);
  const sendingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const retryingRef = useRef(new Set<string>());
  const pollInFlightRef = useRef(false);
  const reqVersionRef = useRef(0);
  const cursorExhaustedRef = useRef(false);
  const pendingSendRef = useRef<{ text: string; key: string } | null>(null);

  const latestReply = messages.find(item => item.companionId !== null);
  const quotaId = latestReply?.status === "FAILED" && latestReply.failure === "QUOTA" ? latestReply.id : undefined;
  const [quotaWallet, setQuotaWallet] = useState<{ messageId: string; wallet: Wallet }>();
  useEffect(() => {
    if (!appActive || !quotaId || !client.wallet) return;
    let current = true;
    void client.wallet().then(wallet => {
      if (current) setQuotaWallet({ messageId: quotaId, wallet });
    }).catch(err => {
      if (current && err instanceof ApiProblemError && err.status === 404) {
        setQuotaWallet({ messageId: quotaId, wallet: { enabled: false } });
      }
    });
    return () => { current = false; };
  }, [appActive, client, quotaId]);

  const sendingRead = useRef<string | undefined>(undefined);
  const lastRead = useRef<string | undefined>(undefined);
  const [readRevision, bumpReadRevision] = useState(0);
  const latestMessage = messages[0];
  useEffect(() => {
    if (!client.markRead || !appActive || !chat || chatIdRef.current !== chat.id) return;
    const messageToRead = chatReadTarget(chat, latestMessage);
    if (!messageToRead) return;
    const chatId = chat.id;
    const key = `${chatId}:${messageToRead}`;
    if (sendingRead.current || lastRead.current === key) return;
    sendingRead.current = key;
    const session = sessionRef.current;

    void client.markRead(chatId, messageToRead).then(() => {
      sendingRead.current = undefined;
      if (session !== sessionRef.current) return;
      lastRead.current = key;
      onRead?.();
      bumpReadRevision(value => value + 1);
    }, () => {
      sendingRead.current = undefined;
    });
  }, [client, appActive, chat, latestMessage, onRead, readRevision]);

  const loadLatest = useCallback(async (targetChatId: string, silent = false) => {
    if (silent && pollInFlightRef.current) return;
    const reqVersion = silent ? reqVersionRef.current : ++reqVersionRef.current;
    const current = () => chatIdRef.current === targetChatId && reqVersion === reqVersionRef.current;
    if (silent) pollInFlightRef.current = true;
    else {
      cursorExhaustedRef.current = false;
      setLoading(true);
    }

    try {
      const page = await client.getChat(targetChatId);
      if (!current()) return;
      setChat(page.chat);
      setMessages((prev) => (silent && prev.length > 0 ? mergeLatestMessages(prev, page.items) : page.items));
      if (!silent) {
        setNextCursor(page.nextCursor);
        if (page.nextCursor === null) cursorExhaustedRef.current = true;
      } else if (!cursorExhaustedRef.current) {
        setNextCursor((prev) => prev ?? page.nextCursor);
      }
      setError(null);
    } catch (e) {
      if (!silent && current()) setError(safeClientMessage(e).title);
    } finally {
      if (silent) pollInFlightRef.current = false;
      else if (current()) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    async function bootstrap() {
      setLoading(true);
      setError(null);
      try {
        let targetId = initialChatId;
        if (!targetId) {
          const list = await client.listChats();
          if (!active) return;
          const matched = companionId
            ? list.items.find((c) => c.direct && c.members.some((m) => m.companionId === companionId))
            : undefined;
          if (matched) {
            targetId = matched.id;
          } else if (companionId) {
            const opened = await client.openChat([companionId]);
            targetId = opened.id;
          }
        }
        if (!active) return;
        if (!targetId) {
          setLoading(false);
          setError("还没有可聊天的对象，请先在「我的」完成添加。");
          return;
        }
        chatIdRef.current = targetId;
        await loadLatest(targetId, false);
        if (active && autoFocus) {
          focusTimer = setTimeout(() => inputRef.current?.focus(), 220);
        }
      } catch (e) {
        if (active) {
          setError(safeClientMessage(e).title);
          setLoading(false);
        }
      }
    }
    void bootstrap();
    return () => {
      active = false;
      sessionRef.current++;
      reqVersionRef.current++;
      chatIdRef.current = undefined;
      clearTimeout(focusTimer);
    };
  }, [client, initialChatId, companionId, autoFocus, loadLatest, bootstrapRevision]);

  useEffect(() => {
    if (!appActive || !chat?.replying || !chatIdRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const activeId = chatIdRef.current;

    const tick = async () => {
      if (cancelled) return;
      await loadLatest(activeId, true);
      if (!cancelled) {
        timer = setTimeout(() => void tick(), 1500);
      }
    };
    timer = setTimeout(() => void tick(), 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [appActive, chat?.replying, loadLatest]);

  useEffect(() => {
    if (appActive && !wasActive.current && chatIdRef.current) {
      void loadLatest(chatIdRef.current, true);
    }
    wasActive.current = appActive;
  }, [appActive, loadLatest]);

  function writeError(err: unknown) {
    if (isGroup && err instanceof ApiProblemError && err.status === 409 && err.code === "INVALID_STATE") {
      onAvailabilityChanged();
      return "群聊暂时无法发送消息，请稍后再试。";
    }
    return safeClientMessage(err).title;
  }

  async function handleSend() {
    const text = draft.trim();
    const targetId = chatIdRef.current;
    if (groupReadOnly || voiceBusy || !text || text.length > 2000 || !targetId || sendingRef.current || deletingRef.current) return;
    const session = sessionRef.current;
    sendingRef.current = true;
    setSending(true);
    setDraft("");
    setTray("none");
    const recipients = chat?.direct === false ? mentions : [];
    const signature = JSON.stringify([text, recipients]);

    const key =
      pendingSendRef.current && pendingSendRef.current.text === signature
        ? pendingSendRef.current.key
        : makeIdempotencyKey("chat-msg");
    pendingSendRef.current = { text: signature, key };

    try {
      const res = await client.sendMessage(targetId, text, recipients, key);
      if (session !== sessionRef.current) return;
      pendingSendRef.current = null;
      setMentions([]);
      setMentionOpen(false);
      acceptSent(res, targetId);
    } catch (e) {
      if (session !== sessionRef.current) return;
      setDraft(current => current || text);
      setError(writeError(e));
    } finally {
      sendingRef.current = false;
      if (session === sessionRef.current) setSending(false);
    }
  }

  function acceptSent(result: ChatSendResult, targetId: string) {
    reqVersionRef.current++;
    setMessages(previous => [result.message, ...previous.filter(message => message.id !== result.message.id)]);
    setChat(previous => previous ? { ...previous, typing: result.typing, replying: result.replying } : previous);
    setError(null);
    if (result.replying) void loadLatest(targetId, true);
  }

  async function sendVoice(input: ChatVoiceInput, key: string) {
    const targetId = chatIdRef.current;
    if (!targetId || !client.sendVoice || groupReadOnly || sendingRef.current || deletingRef.current) {
      throw new ApiProblemError(409, "INVALID_STATE", "CONFLICT", "DO_NOT_RETRY", "local");
    }
    const session = sessionRef.current;
    sendingRef.current = true;
    try {
      const response = await client.sendVoice(targetId, input, key);
      if (session === sessionRef.current) acceptSent(response, targetId);
    } catch (err) {
      if (session === sessionRef.current && isGroup && err instanceof ApiProblemError && err.status === 409) {
        onAvailabilityChanged();
      }
      throw err;
    } finally {
      sendingRef.current = false;
    }
  }

  async function handleRetry(messageId: string) {
    const targetId = chatIdRef.current;
    if (groupReadOnly || !targetId || retryingRef.current.has(messageId)) return;
    const session = sessionRef.current;
    retryingRef.current.add(messageId);
    try {
      const res = await client.retryMessage(targetId, messageId);
      if (session !== sessionRef.current) return;
      reqVersionRef.current += 1;
      setChat((prev) => (prev ? { ...prev, typing: res.typing, replying: res.replying } : prev));
      void loadLatest(targetId, true);
    } catch (e) {
      if (session === sessionRef.current) setError(writeError(e));
    } finally {
      retryingRef.current.delete(messageId);
    }
  }

  async function handleLoadOlder() {
    const targetId = chatIdRef.current;
    if (!targetId || !nextCursor || loadingOlderRef.current) return;
    const session = sessionRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await client.getChat(targetId, nextCursor);
      if (session !== sessionRef.current) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...older.items.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(older.nextCursor);
      if (older.nextCursor === null) cursorExhaustedRef.current = true;
    } catch {
      // ignore transient pagination error
    } finally {
      loadingOlderRef.current = false;
      if (session === sessionRef.current) setLoadingOlder(false);
    }
  }

  async function saveQuote() {
    if (!quote || !onSaveQuote || quotePending.current) return;
    const session = sessionRef.current;
    quotePending.current = true;
    setQuoteSaving(true);
    setQuoteResult("");
    try {
      await onSaveQuote(quote);
      if (session !== sessionRef.current) return;
      setQuote(undefined);
      setQuoteResult("已保存到小家相册。");
    } catch {
      if (session === sessionRef.current) setQuoteResult("这句话没保存成功，请再试一次。");
    } finally {
      quotePending.current = false;
      if (session === sessionRef.current) setQuoteSaving(false);
    }
  }

  async function deleteConversation() {
    if (!chat || sendingRef.current || deletingRef.current) return;
    const session = sessionRef.current;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      await client.deleteChat(chat.id);
      if (session === sessionRef.current) onBackToHome();
    } catch (problem) {
      if (session === sessionRef.current) {
        setConfirmDelete(false);
        setError(safeClientMessage(problem).title);
      }
    } finally {
      deletingRef.current = false;
      if (session === sessionRef.current) setDeleting(false);
    }
  }

  function updateTheme(patch: Partial<ChatThemePreference>) {
    const next = { ...themePref, ...patch };
    setThemePref(next);
    const id = chat?.id ?? initialChatId;
    if (id) void saveChatTheme(ownerId, id, next);
  }

  const theme = resolveChatThemeStyles(themePref, ui);
  const title = chat?.title ?? (chat?.members.map(member => member.displayName).join("、") || companionName);
  const nameFor = (id: string) => chat?.members.find(member => member.companionId === id)?.displayName ?? companionName;
  const speakingIds = chat?.recording ?? [];
  const speakingNames = speakingIds.map(nameFor).join("、");
  const typingNames = (chat?.typing ?? []).filter(id => !speakingIds.includes(id)).map(nameFor).join("、");
  const replyStatus = [speakingNames && `${speakingNames} 正在说话…`, typingNames && `${typingNames} 正在输入…`]
    .filter(Boolean).join("  ");
  const showVoiceComposer = voiceMode && voiceInput && !!chat && mentions.length === 0;
  const hasDraft = Boolean(draft.trim()) && !showVoiceComposer;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
    >
      <LinearGradient pointerEvents="none" colors={[theme.background[0], theme.background[1]]} style={StyleSheet.absoluteFill} />

      {/* Minimal Top Glass Header: icon-only back button */}
      <View style={styles.header}>
        <Pressable
          onPress={onBackToHome}
          style={({ pressed }) => [styles.backCircle, pressed && { opacity: 0.78 }]}
          accessibilityRole="button"
          accessibilityLabel={backLabel}
        >
          <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={StyleSheet.absoluteFill} />
          <Ionicons name="chevron-back" size={19} color={ui.ink} />
        </Pressable>

        <View style={styles.titleBlock}>
          <PixelAvatar name={title} role="companion" uri={chat?.direct ? chat.members[0]?.avatar : undefined} size={30} />
          <View>
            <Text style={styles.titleText} numberOfLines={1}>{title}</Text>
            {replyStatus ? <Text style={styles.typingText}>{replyStatus}</Text> : null}
          </View>
        </View>

        {chat ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="会话操作"
            style={({ pressed }) => [styles.backCircle, pressed && { opacity: 0.78 }]}
            onPress={() => { setConfirmDelete(false); setMenuOpen(true); }}
          >
            <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={StyleSheet.absoluteFill} />
            <Ionicons name="ellipsis-horizontal" size={19} color={ui.ink} />
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          {!chat && !loading && <CommunityButton label="重新加载" onPress={() => setBootstrapRevision(value => value + 1)} />}
        </View>
      ) : null}

      {quoteResult && !quote ? <Text accessibilityLiveRegion="polite" style={styles.quoteResult}>{quoteResult}</Text> : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ui.accent} />
          <Text style={styles.mutedText}>正在打开私密会话…</Text>
        </View>
      ) : (
        <FlatList
          data={messages.filter((item, index) => !item.action || !messages[index - 1]?.action)}
          inverted
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onEndReached={handleLoadOlder}
          onEndReachedThreshold={0.2}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.mutedText}>{groupReadOnly ? "还没有群聊消息。" : `和小家里的 ${title} 说第一句话吧。`}</Text>
            </View>
          }
          ListFooterComponent={
            loadingOlder ? <ActivityIndicator size="small" color={ui.accent} style={{ marginVertical: 12 }} /> : undefined
          }
          renderItem={({ item }) => {
            if (item.action) return <Text style={styles.actionEvent}>{actionLabels[item.action]}</Text>;
            const isMine = item.companionId === null;
            const sender = chat?.members.find(member => member.companionId === item.companionId);
            const senderName = isMine ? ownerName : sender?.displayName ?? title;

            const voiceStatus = playback?.id === item.id ? playback.status : undefined;
            const audioLength = item.audio ? Math.max(1, Math.ceil(item.audio.durationMs / 1000)) : 0;
            const voiceLabel = voiceStatus === "loading" ? "取消加载"
              : voiceStatus === "playing" ? "停止播放" : "播放语音";
            const openQuote = onSaveQuote && chat && item.body && item.status === "SENT"
              ? () => {
                  if (!item.body) return;
                  setQuoteResult("");
                  setQuote({ chatId: chat.id, messageId: item.id, speaker: senderName, text: item.body, sentAt: item.sentAt });
                }
              : undefined;

            return (
              <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
                <PixelAvatar name={senderName} role={isMine ? "owner" : "companion"} uri={isMine ? ownerAvatar : sender?.avatar} size={32} />
                <View style={[styles.bubbleWrap, isMine && styles.bubbleWrapMine]}>
                  {!isMine && !chat?.direct ? (
                    <Text style={styles.senderLabel}>{senderName}</Text>
                  ) : null}
                  <View
                    style={[
                      styles.bubble,
                      isMine
                        ? { backgroundColor: theme.mineBg, borderColor: theme.mineBorder, borderBottomRightRadius: 6 }
                        : { backgroundColor: theme.otherBg, borderColor: theme.otherBorder, borderBottomLeftRadius: 6 },
                    ]}
                  >
                    {item.status === "BLOCKED" ? (
                      <Text style={styles.failedText}>这条回复没有通过安全检查</Text>
                    ) : item.status === "FAILED" ? (
                      <View style={styles.failedWrap}>
                        <Text style={styles.failedText}>
                          {item.failure === "QUOTA"
                            ? quotaMessage(quotaId === item.id && quotaWallet?.messageId === item.id ? quotaWallet.wallet : undefined)
                            : replyFailureMessages[item.failure ?? "ERROR"]}
                        </Text>
                        {item.failure === "ERROR" && item.retryable && !groupReadOnly && (
                          <Pressable onPress={() => void handleRetry(item.id)} style={styles.retryBtn}>
                            <Text style={styles.retryText}>重试</Text>
                          </Pressable>
                        )}
                      </View>
                    ) : (
                      <>
                        {audioLength > 0 && (
                          <View style={styles.voiceRow}>
                            <Text style={styles.voiceMeta}>{isMine ? "语音" : "AI 语音"} · {audioLength} 秒</Text>
                            {client.messageAudio && chat && voiceStatus !== "expired" && (
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={voiceLabel}
                                disabled={voiceBusy}
                                style={styles.voiceButton}
                                onPress={() => void toggle(item.id, () => client.messageAudio!(chat.id, item.id))}
                              >
                                <Ionicons name={voiceStatus === "playing" ? "stop-circle-outline" : "play-circle-outline"} size={21} color={ui.accentInk} />
                                <Text style={styles.voiceMeta}>{voiceLabel}</Text>
                              </Pressable>
                            )}
                            {voiceStatus === "expired" && <Text style={styles.voiceMeta}>语音已过期</Text>}
                            {voiceStatus === "error" && <Text accessibilityRole="alert" style={styles.voiceMeta}>播放失败，可重试</Text>}
                          </View>
                        )}
                        <Pressable
                          disabled={!openQuote}
                          onLongPress={openQuote}
                          accessibilityActions={openQuote ? [{ name: "save-quote", label: "保存到小家相册" }] : undefined}
                          onAccessibilityAction={event => {
                            if (event.nativeEvent.actionName === "save-quote") openQuote?.();
                          }}
                        >
                          <Text style={[styles.msgText, isMine && { color: theme.mineText }]}>
                            {item.body ?? "（消息暂不可显示）"}
                          </Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      <BottomSheet visible={!!quote} title="保存聊天金句" onClose={() => { if (!quoteSaving) setQuote(undefined); }}>
        {quote && (
          <View style={styles.quoteSheet}>
            <Text style={styles.msgText} numberOfLines={5}>{quote.text}</Text>
            {quoteResult !== "" && <Text accessibilityRole="alert" style={styles.mutedText}>{quoteResult}</Text>}
            <CommunityButton label="保存到相册" primary disabled={quoteSaving} onPress={() => void saveQuote()} />
          </View>
        )}
      </BottomSheet>

      <BottomSheet
        visible={menuOpen}
        title={confirmDelete ? "删除会话？" : "会话操作"}
        onClose={() => { if (!deletingRef.current) setMenuOpen(false); }}
      >
        {confirmDelete ? (
          <>
            <Text style={styles.mutedText}>删除后，这段会话将从消息列表移除。</Text>
            <CommunityButton label={deleting ? "正在删除…" : "确认删除"} disabled={deleting || sending} onPress={() => void deleteConversation()} />
          </>
        ) : (
          <>
            {onOpenSettings && <CommunityButton label="聊天设置" onPress={() => { setMenuOpen(false); onOpenSettings(); }} />}
            <CommunityButton label="气泡皮肤与聊天背景" onPress={() => { setMenuOpen(false); setThemeSheetOpen(true); }} />
            <CommunityButton label="删除会话" disabled={sending} onPress={() => setConfirmDelete(true)} />
          </>
        )}
      </BottomSheet>

      <BottomSheet visible={themeSheetOpen} title="气泡皮肤与聊天背景" onClose={() => setThemeSheetOpen(false)}>
        <View style={{ gap: 14 }}>
          <View style={{ gap: 8 }}>
            <Text style={styles.sheetLabel}>气泡皮肤</Text>
            <View style={styles.sheetRow}>
              {BUBBLE_SKINS.map(skin => (
                <CommunityButton
                  key={skin.id}
                  label={skin.label}
                  selected={themePref.bubbleSkin === skin.id}
                  onPress={() => updateTheme({ bubbleSkin: skin.id })}
                />
              ))}
            </View>
          </View>
          <View style={{ gap: 8 }}>
            <Text style={styles.sheetLabel}>聊天背景</Text>
            <View style={styles.sheetRow}>
              {CHAT_BACKGROUNDS.map(bg => (
                <CommunityButton
                  key={bg.id}
                  label={bg.label}
                  selected={themePref.background === bg.id}
                  onPress={() => updateTheme({ background: bg.id })}
                />
              ))}
            </View>
          </View>
        </View>
      </BottomSheet>

      {isGroup && !groupReadOnly && (mentionOpen || mentions.length > 0) && (
        <View style={styles.mentionsBar}>
          {chat.members.map(member => (
            <CommunityButton
              key={member.companionId}
              label={`@${member.displayName}`}
              selected={mentions.includes(member.companionId)}
              disabled={sending || deleting || voiceBusy}
              onPress={() => setMentions(current => current.includes(member.companionId)
                ? current.filter(id => id !== member.companionId) : [...current, member.companionId])}
            />
          ))}
        </View>
      )}

      {/* WeChat-style single-row bottom bar */}
      {groupReadOnly ? (
        <Text style={styles.quoteResult}>群聊暂未开放发言，可以查看记录或删除会话。</Text>
      ) : (
        <View style={styles.composerWrap}>
          {!!attachNotice && <Text style={styles.attachNotice}>{attachNotice}</Text>}
          <View style={styles.wechatBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={voiceMode ? "切换打字" : "切换语音"}
              disabled={voiceBusy || sending || deleting}
              onPress={() => {
                if (!voiceInput) {
                  setAttachNotice("当前环境或服务端暂未开启语音输入，可直接打字。");
                  return;
                }
                setAttachNotice("");
                setTray("none");
                setVoiceMode(prev => !prev);
              }}
              style={styles.iconBtn}
            >
              <Ionicons name={voiceMode ? "keypad-outline" : "mic-outline"} size={23} color={ui.ink} />
            </Pressable>

            {showVoiceComposer ? (
              <View style={{ flex: 1 }}>
                <VoiceComposer disabled={sending || deleting} onRecord={stopPlayback} onChange={setVoiceBusy} onSend={sendVoice} />
              </View>
            ) : (
              <View style={styles.inputPill}>
                {chat?.direct === false && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="提及家机"
                    disabled={voiceBusy}
                    onPress={() => setMentionOpen(value => !value)}
                  >
                    <Ionicons name="at-outline" size={20} color={ui.accentInk} />
                  </Pressable>
                )}
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={val => { setDraft(val); setAttachNotice(""); }}
                  onFocus={() => setTray("none")}
                  placeholder="发消息…"
                  placeholderTextColor={ui.muted}
                  style={styles.input}
                  multiline
                  editable={!!chat && !deleting && !voiceBusy}
                  maxLength={2000}
                  returnKeyType="send"
                  onSubmitEditing={() => void handleSend()}
                />
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="表情"
              disabled={voiceBusy || sending || deleting}
              onPress={() => {
                setVoiceMode(false);
                setAttachNotice("");
                setTray(prev => (prev === "emoji" ? "none" : "emoji"));
              }}
              style={styles.iconBtn}
            >
              <Ionicons name="happy-outline" size={23} color={ui.ink} />
            </Pressable>

            {hasDraft ? (
              <Pressable
                onPress={() => void handleSend()}
                disabled={sending || deleting || voiceBusy || !chat}
                accessibilityRole="button"
                accessibilityLabel="发送消息"
                style={({ pressed }) => [styles.sendBtn, pressed && { transform: [{ scale: 0.94 }] }]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={ui.onAccent} />
                ) : (
                  <Ionicons name="paper-plane-outline" size={16} color={ui.onAccent} />
                )}
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="更多功能"
                disabled={voiceBusy || sending || deleting}
                onPress={() => {
                  setVoiceMode(false);
                  setAttachNotice("");
                  setTray(prev => (prev === "plus" ? "none" : "plus"));
                }}
                style={styles.iconBtn}
              >
                <Ionicons name="add-circle-outline" size={25} color={ui.ink} />
              </Pressable>
            )}
          </View>

          {tray === "emoji" && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.emojiTray}>
              {QUICK_EMOJIS.map(emoji => (
                <Pressable
                  key={emoji}
                  onPress={() => setDraft(prev => (prev + emoji).length <= 2000 ? prev + emoji : prev)}
                  style={styles.emojiBtn}
                >
                  <Text style={styles.emojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {tray === "plus" && (
            <View style={styles.plusTray}>
              {[
                { icon: "image-outline" as const, label: "照片" },
                { icon: "camera-outline" as const, label: "拍照" },
                { icon: "document-outline" as const, label: "文件" },
              ].map(item => (
                <Pressable
                  key={item.label}
                  accessibilityRole="button"
                  onPress={() => setAttachNotice(`${item.label}消息需要后端多媒体接口就绪后开放发送，目前已在排期中。`)}
                  style={styles.plusItem}
                >
                  <View style={styles.plusIconBox}>
                    <Ionicons name={item.icon} size={24} color={ui.accentInk} />
                  </View>
                  <Text style={styles.plusLabel}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  voiceRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7, marginBottom: 4 },
  voiceMeta: { fontSize: 12, color: ui.accentInk },
  voiceButton: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 40, paddingHorizontal: 4 },
  mentionsBar: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 14, gap: 6, paddingBottom: 6 },
  root: { flex: 1 },
  quoteResult: { color: ui.muted, textAlign: "center", paddingVertical: 8 },
  quoteSheet: { gap: 10 },
  sheetLabel: { fontSize: 13.5, fontWeight: "700", color: ui.ink },
  sheetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 10,
  },
  backCircle: {
    width: 38,
    height: 38,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  headerSpacer: { width: 38 },
  titleBlock: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  titleText: { fontSize: 16, fontWeight: "700", color: ui.ink },
  typingText: { fontSize: 11, color: ui.accent, marginTop: 1 },
  errorBanner: {
    marginHorizontal: CHROME.screenInset,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 14,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  errorText: { fontSize: 12.5, color: ui.danger },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  emptyWrap: { paddingVertical: 48, alignItems: "center" },
  mutedText: { fontSize: 13.5, color: ui.muted },
  listContent: { paddingHorizontal: CHROME.screenInset, paddingVertical: 14, gap: 12 },
  actionEvent: { textAlign: "center", color: ui.muted, fontSize: 12, paddingVertical: 7 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 4 },
  msgRowMine: { flexDirection: "row-reverse" },
  bubbleWrap: { maxWidth: "74%" },
  bubbleWrapMine: { alignItems: "flex-end" },
  senderLabel: { fontSize: 11, color: ui.muted, marginBottom: 3, marginLeft: 4 },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
  },
  msgText: { fontSize: 14.5, lineHeight: 21, color: ui.ink },
  failedWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  failedText: { fontSize: 13, color: ui.danger },
  retryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: ui.accentWash,
  },
  retryText: { fontSize: 12, fontWeight: "600", color: ui.accentInk },
  composerWrap: {
    backgroundColor: ui.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ui.line,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 20 : 12,
    gap: 8,
  },
  attachNotice: { fontSize: 12, color: ui.accentInk, textAlign: "center" },
  wechatBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  inputPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ui.background[0],
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    paddingHorizontal: 14,
    minHeight: 40,
    gap: 6,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 96,
    fontSize: 14.5,
    color: ui.ink,
    paddingVertical: 8,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiTray: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    gap: 10,
  },
  emojiBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: ui.background[0],
    alignItems: "center",
    justifyContent: "center",
  },
  emojiText: { fontSize: 20 },
  plusTray: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  plusItem: { alignItems: "center", gap: 6 },
  plusIconBox: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: ui.background[0],
    borderWidth: 1,
    borderColor: ui.line,
    alignItems: "center",
    justifyContent: "center",
  },
  plusLabel: { fontSize: 12, color: ui.muted },
});
