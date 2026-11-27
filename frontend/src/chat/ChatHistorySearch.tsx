import { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { ChatMessage } from "../../../contracts/chat";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { BottomSheet } from "../components/BottomSheet";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";
import { chatTimeDivider } from "./message-time";

type Query = { keyword: string } | { start: number; end: number };
const PAGES_PER_SEARCH = 5;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function normalized(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase();
}

export function ChatHistorySearch({ client, chatId, onClose, onSelect }: {
  client: ChatClient;
  chatId: string;
  onClose: () => void;
  onSelect: (id: string, history: ChatMessage[]) => void;
}) {
  const { ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const [mode, setMode] = useState<"keyword" | "date">("keyword");
  const [input, setInput] = useState("");
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [query, setQuery] = useState<Query>();
  const [matches, setMatches] = useState<ChatMessage[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const pending = useRef(false);
  const history = useRef(new Map<string, ChatMessage>());
  const seenCursors = useRef(new Set<string>());
  const cursor = useRef<string | null | undefined>(undefined);
  useEffect(() => () => { request.current++; }, []);

  function clearSearch() {
    request.current++;
    pending.current = false;
    history.current.clear();
    seenCursors.current.clear();
    cursor.current = undefined;
    setQuery(undefined);
    setMatches([]);
    setMore(false);
    setLoading(false);
    setError("");
  }

  async function search(next: Query, restart: boolean) {
    if (restart) {
      clearSearch();
      setQuery(next);
      Keyboard.dismiss();
    }
    if (pending.current || cursor.current === null) return;
    pending.current = true;
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      for (let pageIndex = 0; pageIndex < PAGES_PER_SEARCH; pageIndex++) {
        const currentCursor = cursor.current;
        const page = await client.getChat(chatId, currentCursor ?? undefined);
        if (version !== request.current) return;
        if (currentCursor) seenCursors.current.add(currentCursor);
        const found: ChatMessage[] = [];
        for (const message of page.items) {
          if (history.current.has(message.id)) continue;
          history.current.set(message.id, message);
          if (message.status !== "SENT" || message.action) continue;
          const time = Date.parse(message.sentAt);
          const matched = "keyword" in next
            ? Boolean(message.body && normalized(message.body).includes(next.keyword))
            : time >= next.start && time < next.end;
          if (matched) found.push(message);
        }
        if (found.length) setMatches(previous => [...previous, ...found]);
        const crossedDay = "start" in next && page.items.some(message => Date.parse(message.sentAt) < next.start);
        const nextCursor = page.nextCursor;
        cursor.current = crossedDay || (nextCursor && seenCursors.current.has(nextCursor)) ? null : nextCursor;
        setMore(cursor.current !== null);
        if (cursor.current === null || found.length) break;
      }
    } catch (err) {
      if (version === request.current) setError(safeClientMessage(err).title);
    } finally {
      if (version === request.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }

  function chooseDay(day: number) {
    const start = new Date(month.getFullYear(), month.getMonth(), day);
    const end = new Date(month.getFullYear(), month.getMonth(), day + 1);
    void search({ start: start.getTime(), end: end.getTime() }, true);
  }

  const year = month.getFullYear();
  const calendarMonth = month.getMonth();
  const today = new Date();
  const monthIsCurrent = today.getFullYear() === year && today.getMonth() === calendarMonth;
  const days = new Date(year, calendarMonth + 1, 0).getDate();
  const firstColumn = month.getDay();
  const submitKeyword = () => {
    if (input.trim()) void search({ keyword: normalized(input.trim()) }, true);
  };

  return (
    <BottomSheet visible title="查找聊天记录" avoidKeyboard onClose={onClose}>
      <ScrollView style={{ maxHeight: height * 0.68 }} contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <CommunityButton label="关键词" selected={mode === "keyword"} onPress={() => {
            if (mode !== "keyword") { setMode("keyword"); clearSearch(); }
          }} />
          <CommunityButton label="按日期" selected={mode === "date"} onPress={() => {
            if (mode !== "date") { Keyboard.dismiss(); setMode("date"); clearSearch(); }
          }} />
        </View>
        {mode === "keyword" ? (
          <View style={styles.row}>
            <TextInput accessibilityLabel="聊天记录关键词" placeholder="搜索关键词" placeholderTextColor={ui.placeholder}
              style={styles.input} value={input} onChangeText={setInput} returnKeyType="search"
              maxLength={200} onSubmitEditing={submitKeyword} />
            <CommunityButton label="搜索" primary disabled={!input.trim() || loading} onPress={submitKeyword} />
          </View>
        ) : (
          <View>
            <View style={[styles.row, styles.monthHeader]}>
              <CommunityButton label="‹" accessibilityLabel="上个月"
                onPress={() => setMonth(new Date(year, calendarMonth - 1, 1))} />
              <Text style={styles.resultText}>{year} 年 {calendarMonth + 1} 月</Text>
              <CommunityButton label="›" accessibilityLabel="下个月" disabled={monthIsCurrent}
                onPress={() => setMonth(new Date(year, calendarMonth + 1, 1))} />
            </View>
            <View style={styles.calendar}>
              {WEEKDAYS.map(day => <Text key={day} style={[styles.day, styles.weekday]}>{day}</Text>)}
              {Array.from({ length: firstColumn }, (_, index) => <View key={`blank-${index}`} style={styles.day} />)}
              {Array.from({ length: days }, (_, index) => {
                const day = index + 1;
                const selected = query && "start" in query &&
                  query.start === new Date(year, calendarMonth, day).getTime();
                const disabled = monthIsCurrent && day > today.getDate();
                return (
                  <Pressable key={day} style={[styles.day, selected && styles.selectedDay]} disabled={disabled}
                    accessibilityRole="button" accessibilityLabel={`${year}年${calendarMonth + 1}月${day}日`}
                    accessibilityState={{ selected, disabled }} onPress={() => chooseDay(day)}>
                    <Text style={[styles.resultText, disabled && styles.disabledDay]}>{day}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
        {matches.length > 0 && (
          <View>
            {matches.map(message => (
              <Pressable key={message.id} accessibilityRole="button" style={styles.result}
                onPress={() => { Keyboard.dismiss(); onSelect(message.id, [...history.current.values()]); }}>
                <Text style={styles.meta}>{chatTimeDivider(message.sentAt)}</Text>
                <Text numberOfLines={2} style={styles.resultText}>{message.body ?? "语音消息"}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {loading && <Text accessibilityLiveRegion="polite" style={styles.meta}>正在查找聊天记录…</Text>}
        {error !== "" && <Text accessibilityRole="alert" style={styles.meta}>{error}</Text>}
        {!loading && query && !error && matches.length === 0 && (
          <Text style={styles.meta}>{more ? "这几页没有找到匹配的消息。" : "没有找到匹配的消息。"}</Text>
        )}
        {!loading && query && (more || error !== "") && (
          <CommunityButton label={error ? "重试查找" : "继续查找更早记录"} onPress={() => void search(query, false)} />
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  body: { gap: 10 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1, minHeight: 44, paddingHorizontal: 12, color: ui.ink, backgroundColor: ui.white,
    borderWidth: 1, borderColor: ui.line, borderRadius: RADIUS.bubble,
  },
  monthHeader: { justifyContent: "space-between" },
  calendar: { flexDirection: "row", flexWrap: "wrap" },
  day: { width: "14%", minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.pill },
  selectedDay: { backgroundColor: ui.accentWash },
  disabledDay: { opacity: 0.45 },
  weekday: { color: ui.muted, textAlign: "center", textAlignVertical: "center", paddingTop: 8 },
  result: { gap: 4, minHeight: 44, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: ui.line },
  resultText: { color: ui.ink, fontSize: 14 },
  meta: { color: ui.muted, fontSize: 12 },
});
