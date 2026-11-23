import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Chat, ChatMessage } from "../../../contracts/chat";
import { makeIdempotencyKey, type ChatClient } from "./client";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { PixelAvatar } from "../components/PixelAvatar";
import { PEARL_UI } from "../theme/skinTokens";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { safeClientMessage } from "../adapters/real-api";

const actionLabels = {
  WAVE: "你向 TA 挥了挥手",
  PAT_HEAD: "你摸了摸 TA 的头",
  HUG: "你抱了抱 TA",
  CUDDLE: "你和 TA 贴了贴",
} satisfies Record<NonNullable<ChatMessage["action"]>, string>;

const replyFailureMessages = {
  UNAVAILABLE: "即将推出",
  DISABLED: "平台模型暂时关闭",
  QUOTA: "今天的免费回复用完了，明天再来",
  ERROR: "这条回复没发出来，可以重试",
};

function mergeLatestMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  // Keep incoming newest order first, then any older paginated items not in incoming
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
  autoFocus = false,
  backLabel = "返回小家",
  onBackToHome,
}: {
  client: ChatClient;
  initialChatId?: string;
  companionId?: string;
  companionName: string;
  ownerName: string;
  autoFocus?: boolean;
  backLabel?: string;
  onBackToHome: () => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const chatIdRef = useRef<string | undefined>(initialChatId);
  const pollInFlightRef = useRef(false);
  const reqVersionRef = useRef(0);
  const cursorExhaustedRef = useRef(false);
  const pendingSendRef = useRef<{ text: string; key: string } | null>(null);

  const loadLatest = useCallback(async (targetChatId: string, silent = false) => {
    if (silent && pollInFlightRef.current) return;
    const reqVersion = silent ? reqVersionRef.current : ++reqVersionRef.current;
    if (silent) pollInFlightRef.current = true;
    else {
      cursorExhaustedRef.current = false;
      setLoading(true);
    }

    try {
      const page = await client.getChat(targetChatId);
      // Discard stale poll response if chat changed or a newer send/load occurred while in flight
      if (chatIdRef.current !== targetChatId || reqVersion !== reqVersionRef.current) return;
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
      if (!silent) setError(safeClientMessage(e).title);
    } finally {
      if (silent) pollInFlightRef.current = false;
      else setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      setLoading(true);
      setError(null);
      try {
        let targetId = initialChatId;
        if (!targetId) {
          const list = await client.listChats();
          const matched = companionId
            ? list.items.find((c) => c.direct && c.members.some((m) => m.companionId === companionId))
            : list.items[0];
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
          setTimeout(() => inputRef.current?.focus(), 220);
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
    };
  }, [client, initialChatId, companionId, autoFocus, loadLatest]);

  // Serialized 1.5s polling whenever replying === true
  useEffect(() => {
    if (!chat?.replying || !chatIdRef.current) return;
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
  }, [chat?.replying, loadLatest]);

  // Refresh immediately when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && chatIdRef.current) {
        void loadLatest(chatIdRef.current, true);
      }
    });
    return () => sub.remove();
  }, [loadLatest]);

  async function handleSend() {
    const text = draft.trim();
    const targetId = chatIdRef.current;
    if (!text || !targetId || sending) return;
    setSending(true);
    setDraft("");

    // Reuse Idempotency-Key if retrying the exact same pending draft after a transient error
    const key =
      pendingSendRef.current && pendingSendRef.current.text === text
        ? pendingSendRef.current.key
        : makeIdempotencyKey("chat-msg");
    pendingSendRef.current = { text, key };

    try {
      const res = await client.sendMessage(targetId, text, undefined, key);
      reqVersionRef.current += 1;
      pendingSendRef.current = null;
      setMessages((prev) => [res.message, ...prev.filter((m) => m.id !== res.message.id)]);
      setChat((prev) => (prev ? { ...prev, typing: res.typing, replying: res.replying } : prev));
      setError(null);
      if (res.replying) {
        void loadLatest(targetId, true);
      }
    } catch (e) {
      setDraft(text);
      setError(safeClientMessage(e).title);
    } finally {
      setSending(false);
    }
  }

  async function handleRetry(messageId: string) {
    const targetId = chatIdRef.current;
    if (!targetId) return;
    try {
      const res = await client.retryMessage(targetId, messageId);
      reqVersionRef.current += 1;
      setChat((prev) => (prev ? { ...prev, typing: res.typing, replying: res.replying } : prev));
      void loadLatest(targetId, true);
    } catch (e) {
      setError(safeClientMessage(e).title);
    }
  }

  async function handleLoadOlder() {
    const targetId = chatIdRef.current;
    if (!targetId || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await client.getChat(targetId, nextCursor);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...older.items.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(older.nextCursor);
      if (older.nextCursor === null) cursorExhaustedRef.current = true;
    } catch {
      // ignore transient pagination error
    } finally {
      setLoadingOlder(false);
    }
  }

  const title = chat?.title ?? chat?.members[0]?.displayName ?? companionName;
  const typingNames = (chat?.typing ?? [])
    .map((id) => chat?.members.find((m) => m.companionId === id)?.displayName ?? companionName)
    .join("、");

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
    >
      <LinearGradient pointerEvents="none" colors={PEARL_UI.background} style={StyleSheet.absoluteFill} />

      {/* Top Glass Header */}
      <View style={styles.header}>
        <Pressable
          onPress={onBackToHome}
          style={({ pressed }) => [styles.backPill, pressed && { opacity: 0.78 }]}
          accessibilityRole="button"
          accessibilityLabel={backLabel}
        >
          <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={StyleSheet.absoluteFill} />
          <Ionicons name="chevron-back" size={17} color={PEARL_UI.ink} />
          {backLabel === "返回小家" && (
            <Ionicons name="home-outline" size={14} color={PEARL_UI.accentInk} />
          )}
          <Text style={styles.backText}>{backLabel}</Text>
        </Pressable>

        <View style={styles.titleBlock}>
          <PixelAvatar name={title} role="companion" size={28} />
          <View>
            <Text style={styles.titleText} numberOfLines={1}>{title}</Text>
            {typingNames ? (
              <Text style={styles.typingText}>
                {`${typingNames} 正在输入…`}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={PEARL_UI.accent} />
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
              <Text style={styles.mutedText}>和小家里的 {title} 说第一句话吧。</Text>
            </View>
          }
          ListFooterComponent={
            loadingOlder ? <ActivityIndicator size="small" color={PEARL_UI.accent} style={{ marginVertical: 12 }} /> : undefined
          }
          renderItem={({ item }) => {
            if (item.action) return <Text style={styles.actionEvent}>{actionLabels[item.action]}</Text>;
            const isMine = item.companionId === null;
            const senderName = isMine
              ? ownerName
              : chat?.members.find((m) => m.companionId === item.companionId)?.displayName ?? title;

            return (
              <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
                <PixelAvatar name={senderName} role={isMine ? "owner" : "companion"} size={30} />
                <View style={[styles.bubbleWrap, isMine && styles.bubbleWrapMine]}>
                  {!isMine && !chat?.direct ? (
                    <Text style={styles.senderLabel}>{senderName}</Text>
                  ) : null}
                  <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther]}>
                    {item.status === "BLOCKED" ? (
                      <Text style={styles.failedText}>这条回复没有通过安全检查</Text>
                    ) : item.status === "FAILED" ? (
                      <View style={styles.failedWrap}>
                        <Text style={styles.failedText}>
                          {replyFailureMessages[item.failure ?? "ERROR"]}
                        </Text>
                        {item.failure === "ERROR" && item.retryable && (
                          <Pressable onPress={() => void handleRetry(item.id)} style={styles.retryBtn}>
                            <Text style={styles.retryText}>重试</Text>
                          </Pressable>
                        )}
                      </View>
                    ) : (
                      <Text style={[styles.msgText, isMine && styles.msgTextMine]}>
                        {item.body ?? "（消息暂不可显示）"}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      {/* Bottom Liquid Glass Composer */}
      <View style={styles.composerBar}>
        <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={styles.composerGlass}>
          <View style={styles.composerRow}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={setDraft}
              placeholder={`和 ${title} 说点什么…`}
              placeholderTextColor={PEARL_UI.muted}
              style={styles.input}
              multiline
              maxLength={2000}
              returnKeyType="send"
              onSubmitEditing={() => void handleSend()}
            />
            <Pressable
              onPress={() => void handleSend()}
              disabled={!draft.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              style={({ pressed }) => [
                styles.sendBtn,
                (!draft.trim() || sending) && styles.sendBtnDisabled,
                pressed && { transform: [{ scale: 0.92 }] },
              ]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="paper-plane-outline" size={16} color="#FFFFFF" />
              )}
            </Pressable>
          </View>
        </LiquidGlassSurface>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 10,
  },
  backPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
  },
  backText: { fontSize: 13, fontWeight: "600", color: PEARL_UI.ink },
  titleBlock: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  titleText: { fontSize: 15, fontWeight: "700", color: PEARL_UI.ink },
  typingText: { fontSize: 11, color: PEARL_UI.accent, marginTop: 1 },
  errorBanner: {
    marginHorizontal: CHROME.screenInset,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderWidth: 1,
    borderColor: PEARL_UI.line,
  },
  errorText: { fontSize: 12.5, color: "#984C59" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  emptyWrap: { paddingVertical: 48, alignItems: "center" },
  mutedText: { fontSize: 13.5, color: PEARL_UI.muted },
  listContent: { paddingHorizontal: CHROME.screenInset, paddingVertical: 14, gap: 12 },
  actionEvent: { textAlign: "center", color: PEARL_UI.muted, fontSize: 12, paddingVertical: 7 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 4 },
  msgRowMine: { flexDirection: "row-reverse" },
  bubbleWrap: { maxWidth: "74%" },
  bubbleWrapMine: { alignItems: "flex-end" },
  senderLabel: { fontSize: 11, color: PEARL_UI.muted, marginBottom: 3, marginLeft: 4 },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
  },
  bubbleOther: {
    backgroundColor: PEARL_UI.white,
    borderColor: PEARL_UI.line,
    borderBottomLeftRadius: 6,
  },
  bubbleMine: {
    backgroundColor: PEARL_UI.iceBlue,
    borderColor: "rgba(255,255,255,0.75)",
    borderBottomRightRadius: 6,
  },
  msgText: { fontSize: 14.5, lineHeight: 21, color: PEARL_UI.ink },
  msgTextMine: { color: "#FFFFFF" },
  failedWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  failedText: { fontSize: 13, color: "#984C59" },
  retryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: PEARL_UI.accentWash,
  },
  retryText: { fontSize: 12, fontWeight: "600", color: PEARL_UI.accentInk },
  composerBar: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 18 : 12,
  },
  composerGlass: { width: "100%" },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 96,
    fontSize: 14.5,
    color: PEARL_UI.ink,
    paddingTop: 7,
    paddingBottom: 7,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: PEARL_UI.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: "rgba(180, 192, 212, 0.55)" },
});
