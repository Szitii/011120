import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import { ScreenSkeleton } from "../theme/ScreenSkeleton";
import type { UiPalette } from "../theme/skinTokens";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
import { setStringAsync } from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Chat, ChatMessage, ChatSendResult, ChatVoiceInput, Wallet } from "../../../contracts/chat";
import { formatChatAction } from "./actions";
import { chatReadTarget, makeIdempotencyKey, type ChatClient } from "./client";
import { chatDraftKey, type ChatDraftStore } from "./draftStore";
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
  loadChatTheme,
  resolveChatThemeStyles,
  type ChatThemePreference,
} from "../theme/chatThemes";

const QUICK_EMOJIS = ["😊", "🥺", "❤️", "😂", "🫂", "✨", "👍", "🌙", "☕️", "🐶", "😭", "🫶"];

const replyFailureMessages = {
  UNAVAILABLE: "即将推出",
  DISABLED: "平台模型暂时关闭",
  ERROR: "这条回复没发出来，可以重试",
};

const MAX_MESSAGE_LENGTH = 2000;

export function formatQuotedReplyPrefix(sourceText: string): string {
  const normalized = sourceText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const quotedLines = normalized.split("\n").map(line => `> ${line}`).join("\n");
  return `${quotedLines}\n`;
}

export function insertQuotedTextIntoDraft(
  currentDraft: string,
  sourceText: string,
  maxLength = MAX_MESSAGE_LENGTH,
): { nextDraft: string; truncated: boolean } {
  const prefix = formatQuotedReplyPrefix(sourceText);
  if (!prefix) return { nextDraft: currentDraft, truncated: false };
  const suffix = currentDraft.replace(/^\n+/, "");
  const availableForPrefix = maxLength - suffix.length;
  if (availableForPrefix <= 4) {
    return { nextDraft: currentDraft, truncated: true };
  }
  if (prefix.length <= availableForPrefix) {
    return { nextDraft: `${prefix}${suffix}`, truncated: false };
  }
  const clippedBody = prefix.slice(0, availableForPrefix - 2).replace(/[\uD800-\uDBFF]$/, "").replace(/\n$/, "");
  return { nextDraft: `${clippedBody}…\n${suffix}`, truncated: true };
}

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
  onOpenProfile,
  onRead,
  groupSendEnabled,
  onAvailabilityChanged,
  draftStore,
}: {
  client: ChatClient;
  draftStore: ChatDraftStore;
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
  onOpenSettings: (chatId: string, companionId?: string) => void;
  onOpenProfile: (companionId: string | null, chatId?: string) => void;
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

  const initialDraftKey = initialChatId
    ? chatDraftKey(ownerId, { chatId: initialChatId })
    : companionId
      ? chatDraftKey(ownerId, { companionId })
      : undefined;
  const [draft, setDraft] = useState(() => draftStore.read(initialDraftKey).text);
  const [mentions, setMentions] = useState<string[]>(() => draftStore.read(initialDraftKey).mentions);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [expandedVoiceIds, setExpandedVoiceIds] = useState<Record<string, boolean>>({});
  const [voiceMenuMsg, setVoiceMenuMsg] = useState<ChatMessage>();
  const [quote, setQuote] = useState<QuoteInput>();
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteResult, setQuoteResult] = useState("");
  const quotePending = useRef(false);
  const quoteFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const draftKeyRef = useRef<string | undefined>(initialDraftKey);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;

  const saveDraft = useCallback((text: string, companionIds: string[]) => {
    draftStore.write(draftKeyRef.current, { text, mentions: companionIds });
  }, [draftStore]);

  const updateDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    saveDraft(text, mentionsRef.current);
  }, [saveDraft]);

  const updateMentions = useCallback((change: (current: string[]) => string[]) => {
    const next = change(mentionsRef.current);
    mentionsRef.current = next;
    setMentions(next);
    saveDraft(draftRef.current, next);
  }, [saveDraft]);

  const adoptDraftKey = useCallback((targetChatId: string) => {
    const nextKey = chatDraftKey(ownerId, { chatId: targetChatId });
    if (!nextKey || nextKey === draftKeyRef.current) return;
    const restored = draftStore.adopt(draftKeyRef.current, nextKey);
    draftKeyRef.current = nextKey;
    draftRef.current = restored.text;
    mentionsRef.current = restored.mentions;
    setDraft(restored.text);
    setMentions(restored.mentions);
  }, [draftStore, ownerId]);

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
        adoptDraftKey(targetId);
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
      if (quoteFocusTimerRef.current) {
        clearTimeout(quoteFocusTimerRef.current);
        quoteFocusTimerRef.current = null;
      }
    };
  }, [client, initialChatId, companionId, autoFocus, loadLatest, bootstrapRevision, adoptDraftKey]);

  useEffect(() => {
    if (!chat || chat.direct !== false) return;
    const current = mentionsRef.current;
    const valid = current.filter(id => chat.members.some(member => member.companionId === id));
    if (valid.length !== current.length) updateMentions(() => valid);
  }, [chat?.id, updateMentions]);

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
    if (groupReadOnly || voiceBusy || !text || text.length > MAX_MESSAGE_LENGTH || !targetId || sendingRef.current) return;
    const session = sessionRef.current;
    sendingRef.current = true;
    setSending(true);
    updateDraft("");
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
      updateMentions(() => []);
      setMentionOpen(false);
      acceptSent(res, targetId);
    } catch (e) {
      if (session !== sessionRef.current) return;
      if (!draftRef.current) updateDraft(text);
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
    if (!targetId || !client.sendVoice || groupReadOnly || sendingRef.current) {
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

  async function copyMessage(text: string) {
    const session = sessionRef.current;
    let copied = false;
    try {
      copied = await setStringAsync(text);
    } catch {
      // A browser may block clipboard access.
    }
    if (session === sessionRef.current) {
      setQuoteResult(copied ? "已复制到剪贴板。" : "复制失败，请长按文字手动复制。");
    }
  }

  async function saveQuoteEntry(target: QuoteInput) {
    if (!onSaveQuote || quotePending.current) return;
    const session = sessionRef.current;
    quotePending.current = true;
    setQuoteSaving(true);
    setQuoteResult("");
    try {
      await onSaveQuote(target);
      if (session !== sessionRef.current) return;
      setQuote(undefined);
      setVoiceMenuMsg(undefined);
      setQuoteResult("已保存到小家相册。");
    } catch {
      if (session === sessionRef.current) setQuoteResult("这句话没保存成功，请再试一次。");
    } finally {
      quotePending.current = false;
      if (session === sessionRef.current) setQuoteSaving(false);
    }
  }

  function quoteMessageToInput(sourceText: string) {
    if (groupReadOnly || voiceBusy) return;
    const { nextDraft, truncated } = insertQuotedTextIntoDraft(draftRef.current, sourceText, MAX_MESSAGE_LENGTH);
    if (nextDraft === draftRef.current && truncated) {
      setQuote(undefined);
      setVoiceMenuMsg(undefined);
      setQuoteResult("输入框字数已满，请先删减后再引用。");
      return;
    }
    setQuote(undefined);
    setVoiceMenuMsg(undefined);
    setAttachNotice("");
    setTray("none");
    setVoiceMode(false);
    updateDraft(nextDraft);
    setQuoteResult(truncated ? "引用内容较长，已截断插入输入框。" : "");
    if (quoteFocusTimerRef.current) clearTimeout(quoteFocusTimerRef.current);
    quoteFocusTimerRef.current = setTimeout(() => {
      quoteFocusTimerRef.current = null;
      inputRef.current?.focus();
    }, 80);
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
  const directMember = chat?.direct ? chat.members[0] : undefined;
  const profileId = chat ? directMember?.companionId : companionId;

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

        <Pressable
          disabled={!profileId}
          accessibilityRole={profileId ? "button" : undefined}
          accessibilityLabel={profileId ? `查看 ${title} 的主页` : undefined}
          onPress={profileId ? () => onOpenProfile(profileId, chat?.direct ? chat.id : undefined) : undefined}
          style={({ pressed }) => [styles.titleBlock, profileId && pressed && { opacity: 0.72 }]}
        >
          <ChatAvatar name={title} avatar={directMember?.avatar} size={30} />
          <View>
            <Text style={styles.titleText} numberOfLines={1}>{title}</Text>
            {replyStatus ? <Text style={styles.typingText}>{replyStatus}</Text> : null}
          </View>
        </Pressable>

        {chat ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="聊天设置"
            style={({ pressed }) => [styles.backCircle, pressed && { opacity: 0.78 }]}
            disabled={sending || voiceBusy}
            onPress={() => onOpenSettings(chat.id, directMember?.companionId)}
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

      {quoteResult && !quote && !voiceMenuMsg ? (
        <Text accessibilityLiveRegion="polite" style={styles.quoteResult}>{quoteResult}</Text>
      ) : null}

      {loading ? (
        <ScreenSkeleton variant="chat" label="正在读取聊天消息" />
      ) : (
        <FlatList
          data={messages.filter((item, index) => {
            if (!item.action || item.companionId !== null) return true;
            const newer = messages[index - 1];
            return !(newer?.action && newer.companionId === null);
          })}
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
            if (item.action) return <Text style={styles.actionEvent}>{formatChatAction(item.action, item.companionId)}</Text>;
            const isMine = item.companionId === null;
            const sender = chat?.members.find(member => member.companionId === item.companionId);
            const senderName = isMine ? ownerName : sender?.displayName ?? title;

            const voiceStatus = playback?.id === item.id ? playback.status : undefined;
            const audioLength = item.audio ? Math.max(1, Math.ceil(item.audio.durationMs / 1000)) : 0;
            const voiceLabel = voiceStatus === "loading" ? "取消加载"
              : voiceStatus === "playing" ? "停止播放" : voiceStatus === "expired" ? "语音已过期" : "播放语音";
            const quotePayload: QuoteInput | undefined = chat && item.body && item.status === "SENT"
              ? { chatId: chat.id, messageId: item.id, speaker: senderName, text: item.body, sentAt: item.sentAt }
              : undefined;
            const openQuote = quotePayload
              ? () => {
                  setQuoteResult("");
                  setQuote(quotePayload);
                }
              : undefined;
            const canQuoteToInput = Boolean(item.body && item.status === "SENT" && !groupReadOnly && !voiceBusy);
            const textA11yActions = quotePayload
              ? [
                  { name: "copy", label: "复制文字" },
                  ...(canQuoteToInput ? [{ name: "quote-reply", label: "引用到输入框" }] : []),
                  ...(onSaveQuote ? [{ name: "save-quote", label: "保存到小家相册" }] : []),
                ]
              : undefined;
            const voiceA11yActions = item.body
              ? [
                  { name: "transcript", label: expandedVoiceIds[item.id] ? "收起文字" : "转文字" },
                  { name: "copy", label: "复制文字" },
                  ...(canQuoteToInput ? [{ name: "quote-reply", label: "引用到输入框" }] : []),
                  ...(onSaveQuote && quotePayload ? [{ name: "save-quote", label: "保存到小家相册" }] : []),
                ]
              : undefined;

            return (
              <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
                <ChatAvatar name={senderName} owner={isMine} avatar={isMine ? ownerAvatar : sender?.avatar} size={32}
                  onPress={() => onOpenProfile(item.companionId, chat?.direct ? chat.id : undefined)} />
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
                        {audioLength > 0 ? (
                          <View style={{ gap: 6 }}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={voiceLabel}
                              disabled={voiceBusy || (!item.body && (!client.messageAudio || voiceStatus === "expired"))}
                              onPress={() => {
                                if (client.messageAudio && chat && voiceStatus !== "expired") {
                                  void toggle(item.id, () => client.messageAudio!(chat.id, item.id));
                                }
                              }}
                              onLongPress={item.body ? () => {
                                setQuoteResult("");
                                setVoiceMenuMsg(item);
                              } : undefined}
                              accessibilityActions={voiceA11yActions}
                              onAccessibilityAction={event => {
                                if (!item.body) return;
                                switch (event.nativeEvent.actionName) {
                                  case "transcript":
                                    setExpandedVoiceIds(prev => ({ ...prev, [item.id]: !prev[item.id] }));
                                    break;
                                  case "copy":
                                    void copyMessage(item.body);
                                    break;
                                  case "quote-reply":
                                    quoteMessageToInput(item.body);
                                    break;
                                  case "save-quote":
                                    if (quotePayload) void saveQuoteEntry(quotePayload);
                                    break;
                                }
                              }}
                              style={[
                                styles.voiceBubble,
                                { minWidth: Math.min(180, 68 + audioLength * 6) },
                                isMine && { flexDirection: "row-reverse" },
                              ]}
                            >
                              <VoiceWave active={voiceStatus === "playing"} color={isMine ? theme.mineText : ui.accentInk} />
                              <Text style={[styles.voiceDuration, isMine && { color: theme.mineText }]}>
                                {audioLength}"
                              </Text>
                              {voiceStatus === "loading" && <ActivityIndicator size="small" color={isMine ? theme.mineText : ui.accent} />}
                            </Pressable>
                            {voiceStatus === "expired" && <Text style={styles.voiceMeta}>语音已过期</Text>}
                            {voiceStatus === "error" && <Text accessibilityRole="alert" style={styles.voiceMeta}>播放失败，可重试</Text>}
                            {expandedVoiceIds[item.id] && !!item.body && (
                              <Text style={[styles.voiceTranscript, isMine && { color: theme.mineText }]}>
                                {item.body}
                              </Text>
                            )}
                          </View>
                        ) : (
                          <Pressable
                            disabled={!openQuote}
                            onLongPress={openQuote}
                            accessibilityActions={textA11yActions}
                            onAccessibilityAction={event => {
                              if (!quotePayload) return;
                              switch (event.nativeEvent.actionName) {
                                case "copy":
                                  void copyMessage(quotePayload.text);
                                  break;
                                case "quote-reply":
                                  quoteMessageToInput(quotePayload.text);
                                  break;
                                case "save-quote":
                                  void saveQuoteEntry(quotePayload);
                                  break;
                              }
                            }}
                          >
                            <Text style={[styles.msgText, isMine && { color: theme.mineText }]}>
                              {item.body ?? "（消息暂不可显示）"}
                            </Text>
                          </Pressable>
                        )}
                      </>
                    )}
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      <BottomSheet
        visible={!!quote || !!voiceMenuMsg}
        title={quote ? "聊天文字" : "语音消息"}
        onClose={() => {
          if (quoteSaving) return;
          setQuote(undefined);
          setVoiceMenuMsg(undefined);
        }}
      >
        {quote && (
          <View style={styles.quoteSheet}>
            <Text style={styles.msgText} numberOfLines={5} selectable>{quote.text}</Text>
            {quoteResult !== "" && <Text accessibilityRole="alert" style={styles.mutedText}>{quoteResult}</Text>}
            <CommunityButton
              label="复制文字"
              onPress={() => {
                const text = quote.text;
                setQuote(undefined);
                void copyMessage(text);
              }}
            />
            {!groupReadOnly && !voiceBusy && (
              <CommunityButton
                label="引用到输入框"
                onPress={() => quoteMessageToInput(quote.text)}
              />
            )}
            {onSaveQuote && (
              <CommunityButton
                label="保存到小家相册"
                primary
                disabled={quoteSaving}
                onPress={() => void saveQuoteEntry(quote)}
              />
            )}
          </View>
        )}
        {!quote && voiceMenuMsg && (
          <View style={styles.quoteSheet}>
            {!!voiceMenuMsg.body && (
              <Text style={styles.msgText} numberOfLines={5} selectable>{voiceMenuMsg.body}</Text>
            )}
            {quoteResult !== "" && <Text accessibilityRole="alert" style={styles.mutedText}>{quoteResult}</Text>}
            {!!voiceMenuMsg.body && (
              <CommunityButton
                primary
                label={expandedVoiceIds[voiceMenuMsg.id] ? "收起文字" : "转文字"}
                onPress={() => {
                  const id = voiceMenuMsg.id;
                  setExpandedVoiceIds(prev => ({ ...prev, [id]: !prev[id] }));
                  setVoiceMenuMsg(undefined);
                }}
              />
            )}
            {!!voiceMenuMsg.body && (
              <CommunityButton
                label="复制文字"
                onPress={() => {
                  if (!voiceMenuMsg.body) return;
                  const text = voiceMenuMsg.body;
                  setVoiceMenuMsg(undefined);
                  void copyMessage(text);
                }}
              />
            )}
            {!!voiceMenuMsg.body && voiceMenuMsg.status === "SENT" && !groupReadOnly && !voiceBusy && (
              <CommunityButton
                label="引用到输入框"
                onPress={() => {
                  if (!voiceMenuMsg.body) return;
                  quoteMessageToInput(voiceMenuMsg.body);
                }}
              />
            )}
            {onSaveQuote && chat && voiceMenuMsg.body && voiceMenuMsg.status === "SENT" && (
              <CommunityButton
                label="保存到小家相册"
                disabled={quoteSaving}
                onPress={() => {
                  const m = voiceMenuMsg;
                  if (!m.body) return;
                  const speaker = m.companionId === null
                    ? ownerName
                    : chat.members.find(member => member.companionId === m.companionId)?.displayName ?? title;
                  void saveQuoteEntry({
                    chatId: chat.id,
                    messageId: m.id,
                    speaker,
                    text: m.body,
                    sentAt: m.sentAt,
                  });
                }}
              />
            )}
          </View>
        )}
      </BottomSheet>

      {isGroup && !groupReadOnly && (mentionOpen || mentions.length > 0) && (
        <View style={styles.mentionsBar}>
          {chat.members.map(member => (
            <CommunityButton
              key={member.companionId}
              label={`@${member.displayName}`}
              selected={mentions.includes(member.companionId)}
              disabled={sending || voiceBusy}
              onPress={() => updateMentions(current => current.includes(member.companionId)
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
            {voiceInput && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={voiceMode ? "切换打字" : "切换语音"}
                disabled={voiceBusy || sending}
                onPress={() => {
                  setAttachNotice("");
                  setTray("none");
                  setVoiceMode(prev => !prev);
                }}
                style={styles.iconBtn}
              >
                <Ionicons name={voiceMode ? "keypad-outline" : "mic-outline"} size={23} color={ui.ink} />
              </Pressable>
            )}

            {showVoiceComposer ? (
              <View style={{ flex: 1 }}>
                <VoiceComposer disabled={sending} onRecord={stopPlayback} onChange={setVoiceBusy} onSend={sendVoice} />
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
                  onChangeText={val => { updateDraft(val); setAttachNotice(""); }}
                  onFocus={() => setTray("none")}
                  placeholder="发消息…"
                  placeholderTextColor={ui.muted}
                  style={styles.input}
                  multiline
                  editable={!!chat && !voiceBusy}
                  maxLength={MAX_MESSAGE_LENGTH}
                  returnKeyType="send"
                  onSubmitEditing={() => void handleSend()}
                />
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="表情"
              disabled={voiceBusy || sending}
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
                disabled={sending || voiceBusy || !chat}
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
                disabled={voiceBusy || sending}
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
                  onPress={() => {
                    const next = draftRef.current + emoji;
                    if (next.length <= MAX_MESSAGE_LENGTH) updateDraft(next);
                  }}
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

function VoiceWave({ active, color }: { active: boolean; color: string }) {
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active) return;
    const wave = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: .45, duration: 320, useNativeDriver: Platform.OS !== "web" }),
      Animated.timing(pulse, { toValue: 1, duration: 320, useNativeDriver: Platform.OS !== "web" }),
    ]));
    wave.start();
    return () => {
      wave.stop();
      pulse.setValue(1);
    };
  }, [active, pulse]);
  return <Animated.View style={{ opacity: pulse }}>
    <Ionicons name={active ? "volume-high" : "volume-medium-outline"} size={18} color={color} />
  </Animated.View>;
}

function ChatAvatar({ name, owner, avatar, size, onPress }: {
  name: string;
  owner?: boolean;
  avatar?: string | null;
  size: number;
  onPress?: () => void;
}) {
  const face = <PixelAvatar name={name} role={owner ? "owner" : "companion"} uri={avatar} size={size} />;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${name} 的主页`}
    hitSlop={6} onPress={onPress}>{face}</Pressable> : face;
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  voiceBubble: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 2 },
  voiceDuration: { fontSize: 14, fontWeight: "600", color: ui.ink },
  voiceTranscript: { fontSize: 13.5, lineHeight: 20, color: ui.ink, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ui.line },
  voiceMeta: { fontSize: 12, color: ui.accentInk },
  mentionsBar: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 14, gap: 6, paddingBottom: 6 },
  root: { flex: 1 },
  quoteResult: { color: ui.muted, textAlign: "center", paddingVertical: 8 },
  quoteSheet: { gap: 10 },
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
