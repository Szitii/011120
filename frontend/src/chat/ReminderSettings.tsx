import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatReminder } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { useThemedStyles } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";
import { formatReminderTime } from "./reminders";

export function ReminderSettings({ client, companionId }: { client: ChatClient; companionId: string }) {
  const styles = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ChatReminder[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState<string>();
  const pending = useRef(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const { listReminders, cancelReminder } = client;
  if (!listReminders || !cancelReminder) return null;

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      if (active.current) setError(safeClientMessage(failure).title);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const load = () => run(async () => {
    const next = await listReminders(companionId);
    if (active.current) setItems(next.items);
  });

  function cancel(id: string) {
    void run(async () => {
      try {
        const result = await cancelReminder!(companionId, id);
        if (result.deleted !== true) throw new Error("Reminder cancellation was not confirmed.");
        if (active.current) setNotice("提醒已取消。");
      } catch (failure) {
        if (!(failure instanceof ApiProblemError) || failure.status !== 404) throw failure;
        const next = await listReminders!(companionId);
        if (!active.current) return;
        setItems(next.items);
        setConfirmId(undefined);
        setNotice("这条提醒的状态已更新。");
        return;
      }
      if (!active.current) return;
      setItems(previous => previous?.filter(item => item.id !== id));
      setConfirmId(undefined);
    });
  }

  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} disabled={busy}
        style={styles.header} onPress={() => {
          setExpanded(!expanded);
          setConfirmId(undefined);
          if (!expanded) void load();
        }}>
        <Text style={styles.title}>待提醒</Text>
        <Text style={styles.meta}>{items ? `${items.length} 条` : "查看"}</Text>
      </Pressable>
      {expanded && <>
        {notice !== "" && <Text accessibilityLiveRegion="polite" style={styles.meta}>{notice}</Text>}
        {error !== "" && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {busy && <Text accessibilityLiveRegion="polite" style={styles.meta}>正在更新提醒…</Text>}
        {!busy && error !== "" && confirmId === undefined && <CommunityButton label="重试读取提醒" onPress={() => void load()} />}
        {!busy && items?.length === 0 && <Text style={styles.meta}>没有待提醒。可以在私聊里告诉 TA 什么时候提醒你。</Text>}
        {items?.map(item => (
          <View key={item.id} style={styles.entry}>
            <Text style={styles.title}>{item.note}</Text>
            <Text style={styles.meta}>{formatReminderTime(item.dueAt) ?? "提醒时间暂不可显示"}</Text>
            <View style={styles.actions}>
              {confirmId === item.id ? <>
                <CommunityButton label="确认取消提醒" disabled={busy} onPress={() => cancel(item.id)} />
                <CommunityButton label="保留提醒" disabled={busy} onPress={() => setConfirmId(undefined)} />
              </> : <CommunityButton label="取消提醒" accessibilityLabel={`取消提醒：${item.note}`} disabled={busy}
                onPress={() => { setError(""); setConfirmId(item.id); }} />}
            </View>
          </View>
        ))}
      </>}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  card: { padding: 14, gap: 8, borderWidth: 1, borderColor: ui.line, borderRadius: RADIUS.bubble, backgroundColor: ui.white },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 44, gap: 8 },
  title: { color: ui.ink, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  meta: { color: ui.muted, fontSize: 13 },
  error: { color: ui.danger, fontSize: 13 },
  entry: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: ui.line, paddingVertical: 8, gap: 6 },
  actions: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
