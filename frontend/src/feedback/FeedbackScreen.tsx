import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { Feedback } from "../../../contracts/chat.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { makeIdempotencyKey, type ChatClient } from "../chat/client";
import { CommunityButton } from "../community/components";
import appConfig from "../../app.json";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

const MAX_BODY_CHARS = 2000;

function currentPlatform(): "IOS" | "ANDROID" | "WEB" {
  if (Platform.OS === "ios") return "IOS";
  if (Platform.OS === "android") return "ANDROID";
  return "WEB";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

function feedbackErrorText(error: unknown): string {
  if (error instanceof ApiProblemError) {
    if (error.status === 409) return "今天发得有点多了，明天再来吧。";
    if (error.status === 404) return "这条反馈已不存在，已为你刷新列表。";
  }
  return safeClientMessage(error).title;
}

export function FeedbackScreen({
  client,
  onRead,
}: {
  client: ChatClient;
  onRead?: () => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);

  const [mode, setMode] = useState<"list" | "compose" | "detail">("list");
  const [items, setItems] = useState<Feedback[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  // Compose new feedback state (preserve draft & idempotency key on retry)
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string>();
  const composeKey = useRef<string | null>(null);

  // Detail follow-up state (preserve draft & idempotency key on retry)
  const [replyDraft, setReplyDraft] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string>();
  const replyKey = useRef<string | null>(null);
  const detailScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);

  const loadList = useCallback(async (silent = false) => {
    if (!client.listFeedback) {
      setLoading(false);
      setError("当前环境暂不支持意见反馈。");
      return;
    }
    if (!silent) setLoading(true);
    setError(undefined);
    try {
      const result = await client.listFeedback();
      setItems(result.items);
      onRead?.();
    } catch (err) {
      setError(feedbackErrorText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client, onRead]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const selected = items.find(item => item.id === selectedId);

  const openThread = useCallback((item: Feedback) => {
    setSelectedId(item.id);
    setReplyDraft("");
    setReplyError(undefined);
    replyKey.current = null;
    setMode("detail");

    if (item.unread && client.markFeedbackRead) {
      void client.markFeedbackRead(item.id).then(updated => {
        setItems(prev => prev.map(row => (row === item ? updated : row)));
        onRead?.();
      }).catch(() => {
        // Non-blocking: user can still read thread messages.
      });
    }
  }, [client, onRead]);

  const submitNew = async () => {
    const body = draft.trim();
    if (!body || Array.from(body).length > MAX_BODY_CHARS || !client.createFeedback || sending) return;
    setSending(true);
    setComposeError(undefined);
    if (!composeKey.current) composeKey.current = makeIdempotencyKey("fb-new");
    try {
      const created = await client.createFeedback(
        { body, appVersion: appConfig.expo.version, platform: currentPlatform() },
        composeKey.current,
      );
      composeKey.current = null;
      setDraft("");
      setItems(prev => [created, ...prev.filter(row => row.id !== created.id)]);
      setSelectedId(created.id);
      setMode("detail");
      onRead?.();
    } catch (err) {
      setComposeError(feedbackErrorText(err));
    } finally {
      setSending(false);
    }
  };

  const submitReply = async () => {
    const body = replyDraft.trim();
    if (!selected || !body || Array.from(body).length > MAX_BODY_CHARS || !client.replyFeedback || replySending) return;
    setReplySending(true);
    setReplyError(undefined);
    if (!replyKey.current) replyKey.current = makeIdempotencyKey("fb-reply");
    try {
      const updated = await client.replyFeedback(selected.id, body, replyKey.current);
      replyKey.current = null;
      setReplyDraft("");
      setItems(prev => [updated, ...prev.filter(row => row.id !== updated.id)]);
      onRead?.();
    } catch (err) {
      const message = feedbackErrorText(err);
      if (err instanceof ApiProblemError && err.status === 404) {
        await loadList();
        setError(message);
        setMode("list");
      } else {
        setReplyError(message);
      }
    } finally {
      setReplySending(false);
    }
  };

  if (mode === "compose") {
    const charCount = Array.from(draft.trim()).length;
    const canSend = charCount > 0 && charCount <= MAX_BODY_CHARS && !sending;
    return (
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.subHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回反馈列表"
            disabled={sending}
            onPress={() => setMode("list")}
            style={styles.textLinkBtn}
          >
            <Text style={styles.textLink}>取消</Text>
          </Pressable>
          <Text style={styles.subTitle}>写反馈</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.composeContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.inputCard}>
            <TextInput
              value={draft}
              onChangeText={text => {
                setDraft(Array.from(text).slice(0, MAX_BODY_CHARS).join(""));
                composeKey.current = null;
                if (composeError) setComposeError(undefined);
              }}
              placeholder="遇到的问题或者想要的功能都可以写，我们会回复你"
              placeholderTextColor={ui.muted}
              multiline
              textAlignVertical="top"
              style={styles.composeInput}
              editable={!sending}
            />
            <Text style={styles.counterText}>{charCount} / {MAX_BODY_CHARS}</Text>
          </View>

          {composeError ? (
            <Text accessibilityRole="alert" style={styles.errorText}>{composeError}</Text>
          ) : null}

          <CommunityButton
            primary
            label={sending ? "正在提交…" : "提交反馈"}
            disabled={!canSend}
            onPress={() => void submitNew()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  if (mode === "detail" && selected) {
    const replyLen = Array.from(replyDraft.trim()).length;
    const canReply = replyLen > 0 && replyLen <= MAX_BODY_CHARS && !replySending;
    return (
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.subHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回反馈列表"
            disabled={replySending}
            onPress={() => setMode("list")}
            style={styles.textLinkBtn}
          >
            <Ionicons name="chevron-back" size={16} color={ui.accentInk} />
            <Text style={styles.textLink}>全部反馈</Text>
          </Pressable>
          <View style={[styles.statusBadge, selected.status === "CLOSED" && styles.statusBadgeClosed]}>
            <Text style={[styles.statusText, selected.status === "CLOSED" && styles.statusTextClosed]}>
              {selected.status === "CLOSED" ? "已处理" : "处理中"}
            </Text>
          </View>
        </View>

        <ScrollView
          ref={detailScrollRef}
          style={styles.flex}
          contentContainerStyle={styles.chatContent}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => detailScrollRef.current?.scrollToEnd({ animated: false })}
        >
          {selected.messages.map(msg => {
            const isOwner = msg.author === "OWNER";
            return (
              <View
                key={msg.id}
                style={[styles.bubbleRow, isOwner ? styles.bubbleRowMine : styles.bubbleRowTeam]}
              >
                {!isOwner && <Text style={styles.teamLabel}>官方回复</Text>}
                <View style={[styles.bubble, isOwner ? styles.bubbleMine : styles.bubbleTeam]}>
                  <Text style={styles.bubbleText} selectable>{msg.body}</Text>
                </View>
                <Text style={styles.bubbleTime}>{formatTime(msg.createdAt)}</Text>
              </View>
            );
          })}
          {selected.status === "CLOSED" && (
            <Text style={styles.closedHint}>该反馈已标记为已处理，继续发送消息会自动重新开启。</Text>
          )}
        </ScrollView>

        {replyError ? (
          <View style={styles.replyErrorBar}>
            <Text accessibilityRole="alert" style={styles.errorText}>{replyError}</Text>
          </View>
        ) : null}

        <View style={styles.composerBar}>
          <TextInput
            value={replyDraft}
            onChangeText={text => {
              setReplyDraft(Array.from(text).slice(0, MAX_BODY_CHARS).join(""));
              replyKey.current = null;
              if (replyError) setReplyError(undefined);
            }}
            placeholder="补充说明或继续追问…"
            placeholderTextColor={ui.muted}
            multiline
            style={styles.replyInput}
            editable={!replySending}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送追问"
            disabled={!canReply}
            onPress={() => void submitReply()}
            style={({ pressed }) => [
              styles.sendBtn,
              !canReply && styles.sendBtnDisabled,
              pressed && canReply && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.sendBtnText}>{replySending ? "…" : "发送"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.page}>
      <View style={styles.subHeader}>
        <Text style={styles.subTitle}>意见反馈</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="写反馈"
          disabled={loading || refreshing}
          onPress={() => {
            setComposeError(undefined);
            setMode("compose");
          }}
          style={({ pressed }) => [styles.writeBtn, pressed && { opacity: 0.82 }]}
        >
          <Ionicons name="create-outline" size={15} color={ui.onAccent} />
          <Text style={styles.writeBtnText}>写反馈</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadList(true);
            }}
          />
        }
      >
        {error && items.length > 0 && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
        {loading && items.length === 0 ? (
          <View style={styles.centerBox}>
            <ActivityIndicator />
          </View>
        ) : error && items.length === 0 ? (
          <View style={styles.centerBox}>
            <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>
            <CommunityButton label="重新加载" onPress={() => void loadList()} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="chatbox-ellipses-outline" size={24} color={ui.accent} />
            <Text style={styles.emptyTitle}>还没有提交过反馈</Text>
            <Text style={styles.emptySub}>遇到的问题或想要的新功能都可以写给我们，回复后会在这里提醒你。</Text>
          </View>
        ) : (
          <View style={styles.listCard}>
            {items.map((item, idx) => {
              const firstMsg = item.messages[0]?.body ?? "（无内容）";
              const lastMsg = item.messages[item.messages.length - 1];
              const hasTeamReply = item.messages.some(m => m.author === "TEAM");
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  disabled={loading || refreshing}
                  onPress={() => openThread(item)}
                  style={({ pressed }) => [
                    styles.listRow,
                    idx < items.length - 1 && styles.listRowDivider,
                    pressed && { backgroundColor: ui.background[0] },
                  ]}
                >
                  <View style={styles.rowTop}>
                    <View style={styles.rowTitleWrap}>
                      {item.unread && <View style={styles.unreadDot} />}
                      <Text style={styles.rowTitle} numberOfLines={1}>{firstMsg}</Text>
                    </View>
                    <View style={[styles.statusBadge, item.status === "CLOSED" && styles.statusBadgeClosed]}>
                      <Text style={[styles.statusText, item.status === "CLOSED" && styles.statusTextClosed]}>
                        {item.status === "CLOSED" ? "已处理" : "处理中"}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.rowBottom}>
                    <Text style={styles.rowPreview} numberOfLines={1}>
                      {hasTeamReply && lastMsg?.author === "TEAM"
                        ? `官方回复：${lastMsg.body}`
                        : `共 ${item.messages.length} 条记录`}
                    </Text>
                    <Text style={styles.rowTime}>{formatTime(item.updatedAt)}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (ui: UiPalette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: ui.background[0] },
    flex: { flex: 1 },
    subHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: CHROME.screenInset,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: ui.line,
    },
    subTitle: { fontSize: 17, fontWeight: "700", color: ui.ink },
    headerSpacer: { width: 44 },
    textLinkBtn: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 4 },
    textLink: { fontSize: 14, fontWeight: "600", color: ui.accentInk },
    writeBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: ui.accent,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: RADIUS.pill,
    },
    writeBtnText: { fontSize: 13, fontWeight: "600", color: ui.onAccent },
    listContent: { padding: CHROME.screenInset, paddingBottom: 32, gap: 12 },
    centerBox: { paddingVertical: 48, alignItems: "center", gap: 12 },
    emptyCard: {
      backgroundColor: ui.white,
      borderRadius: RADIUS.bubble,
      borderWidth: 1,
      borderColor: ui.line,
      padding: 24,
      alignItems: "center",
      gap: 8,
    },
    emptyTitle: { fontSize: 15, fontWeight: "600", color: ui.ink },
    emptySub: { fontSize: 13, color: ui.muted, textAlign: "center", lineHeight: 19 },
    listCard: {
      backgroundColor: ui.white,
      borderRadius: RADIUS.bubble,
      borderWidth: 1,
      borderColor: ui.line,
      overflow: "hidden",
    },
    listRow: { padding: 14, gap: 6 },
    listRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ui.line },
    rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    rowTitleWrap: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
    unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: ui.danger },
    rowTitle: { fontSize: 15, fontWeight: "600", color: ui.ink, flex: 1 },
    rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    rowPreview: { fontSize: 13, color: ui.muted, flex: 1 },
    rowTime: { fontSize: 11.5, color: ui.muted },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: RADIUS.pill,
      backgroundColor: ui.iceBlue,
    },
    statusBadgeClosed: { backgroundColor: ui.background[0] },
    statusText: { fontSize: 11, fontWeight: "600", color: ui.accentInk },
    statusTextClosed: { color: ui.muted },
    composeContent: { padding: CHROME.screenInset, gap: 12 },
    inputCard: {
      backgroundColor: ui.white,
      borderRadius: RADIUS.bubble,
      borderWidth: 1,
      borderColor: ui.line,
      padding: 14,
      gap: 8,
    },
    composeInput: { minHeight: 160, fontSize: 15, color: ui.ink, lineHeight: 22 },
    counterText: { fontSize: 12, color: ui.muted, textAlign: "right" },
    errorText: { fontSize: 13, color: ui.danger },
    chatContent: { padding: CHROME.screenInset, gap: 12, paddingBottom: 24 },
    bubbleRow: { gap: 4, maxWidth: "84%" },
    bubbleRowMine: { alignSelf: "flex-end", alignItems: "flex-end" },
    bubbleRowTeam: { alignSelf: "flex-start", alignItems: "flex-start" },
    teamLabel: { fontSize: 11.5, fontWeight: "600", color: ui.accentInk, marginLeft: 4 },
    bubble: { borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10 },
    bubbleMine: { backgroundColor: ui.iceBlue, borderWidth: 1, borderColor: ui.highlight },
    bubbleTeam: { backgroundColor: ui.white, borderWidth: 1, borderColor: ui.line },
    bubbleText: { fontSize: 14.5, color: ui.ink, lineHeight: 21 },
    bubbleTime: { fontSize: 11, color: ui.muted, marginHorizontal: 4 },
    closedHint: { fontSize: 12, color: ui.muted, textAlign: "center", marginTop: 8 },
    replyErrorBar: { paddingHorizontal: CHROME.screenInset, paddingBottom: 6 },
    composerBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      paddingHorizontal: CHROME.screenInset,
      paddingVertical: 10,
      backgroundColor: ui.white,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: ui.line,
    },
    replyInput: {
      flex: 1,
      minHeight: 38,
      maxHeight: 110,
      backgroundColor: ui.background[0],
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 8,
      fontSize: 14.5,
      color: ui.ink,
    },
    sendBtn: {
      backgroundColor: ui.accent,
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: RADIUS.pill,
    },
    sendBtnDisabled: { opacity: 0.45 },
    sendBtnText: { fontSize: 14, fontWeight: "600", color: ui.onAccent },
  });
