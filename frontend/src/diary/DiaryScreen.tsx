import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { setStringAsync } from "expo-clipboard";
import type { DiaryEntry, DiaryWriteResult } from "../../../contracts/chat.ts";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import { PixelAvatar } from "../components/PixelAvatar";
import type { OwnerCompanionSummary } from "../contracts";
import { useAppIsActive } from "../state/useAppIsActive";
import { RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { DiaryFrequency } from "./DiaryFrequency";
import type { DiaryClient } from "./client";

function diaryDate(entry: DiaryEntry) {
  return new Date(entry.writtenAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

export function DiaryScreen({
  client,
  companionId,
  companionName,
  companions = [],
  onSelectCompanion,
}: {
  client: DiaryClient;
  companionId: string;
  companionName: string;
  companions?: OwnerCompanionSummary[];
  onSelectCompanion?: (companion: OwnerCompanionSummary) => void;
}) {
  const s = useCommunityStyles();
  const ds = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [items, setItems] = useState<DiaryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sharedNotice, setSharedNotice] = useState<{ id: string; message: string }>();
  const sharing = useRef(false);
  const [generating, setGenerating] = useState(true);
  const [writingElsewhere, setWritingElsewhere] = useState(false);
  const [readError, setReadError] = useState<{ title: string; cursor?: string }>();
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const session = useRef(0);
  const write = useRef<Promise<DiaryWriteResult> | undefined>(undefined);
  const removed = useRef(new Set<string>());
  const reading = useRef(false);
  const polling = useRef(false);
  const foregroundRead = useRef(0);
  const removing = useRef(false);
  const appActive = useAppIsActive();

  const merge = useCallback((incoming: DiaryEntry[]) => {
    const entries = incoming.filter(entry => entry.companionId === companionId);
    setItems(previous => {
      const byId = new Map([...previous, ...entries].map(entry => [entry.id, entry]));
      return [...byId.values()].filter(entry => !removed.current.has(entry.id))
        .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt) || b.id.localeCompare(a.id));
    });
  }, [companionId]);

  const read = useCallback(async (older?: string, mode: "load" | "background" | "refresh" = "load") => {
    const background = mode === "background";
    const pending = background ? polling : reading;
    if (pending.current || (background && reading.current)) return;
    const scope = session.current;
    const readRevision = background ? foregroundRead.current : ++foregroundRead.current;
    pending.current = true;
    if (!background) {
      setReadError(undefined);
      if (older) setLoadingOlder(true);
      else if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
    }
    try {
      const page = await client.list(companionId, older);
      if (scope !== session.current || readRevision !== foregroundRead.current) return;
      merge(page.items);
      if (!background) setCursor(page.nextCursor);
      if (!older) setWritingElsewhere(page.writing);
    } catch (error) {
      if (scope === session.current && !background) setReadError({ title: safeClientMessage(error).title, cursor: older });
    } finally {
      if (scope === session.current) {
        pending.current = false;
        if (!background) {
          setLoading(false);
          setLoadingOlder(false);
          setRefreshing(false);
        }
      }
    }
  }, [client, companionId, merge]);

  useEffect(() => {
    const scope = ++session.current;
    void read();
    write.current ??= client.writeIfDue(companionId);
    void write.current.then(result => {
      if (scope !== session.current) return;
      if (result.status === "WRITTEN" && result.entry) merge([result.entry]);
      if (result.status === "WRITING") setWritingElsewhere(true);
      if (result.status === "OFF") setNotice("日记已关闭，可以在家机设置里开启。");
      if (result.failure === "UNAVAILABLE") setNotice("即将推出");
      if (result.failure === "QUOTA") setNotice("今天累了，明天再写。");
    }).catch(() => {
      if (scope === session.current) setNotice("暂时无法确认日记是否写好，已有日记仍可阅读。");
    }).finally(() => {
      if (scope === session.current) setGenerating(false);
    });
    return () => {
      session.current++;
      reading.current = false;
      polling.current = false;
    };
  }, [client, companionId, merge, read]);

  useEffect(() => {
    if (!appActive || generating || !writingElsewhere) return;
    let active = true;
    let remaining = 60;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await read(undefined, "background");
      if (active && --remaining > 0) timer = setTimeout(() => void tick(), 3000);
      else if (active) {
        setWritingElsewhere(false);
        setNotice("日记暂时还未写完，稍后再打开看看。");
      }
    };
    timer = setTimeout(() => void tick(), 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [appActive, generating, read, writingElsewhere]);

  async function remove(id: string) {
    if (removing.current) return;
    const scope = session.current;
    removing.current = true;
    setDeleting(true);
    setNotice("");
    try {
      await client.remove(companionId, id);
      if (scope !== session.current) return;
      removed.current.add(id);
      setItems(previous => previous.filter(entry => entry.id !== id));
      setConfirmId(undefined);
    } catch (error) {
      if (scope === session.current) setNotice(safeClientMessage(error).title);
    } finally {
      removing.current = false;
      if (scope === session.current) setDeleting(false);
    }
  }

  const writing = generating || writingElsewhere;
  const canShare = Platform.OS !== "web" || (typeof navigator !== "undefined" && typeof navigator.share === "function");
  async function shareEntry(entry: DiaryEntry, copy: boolean) {
    if (sharing.current) return;
    sharing.current = true;
    const scope = session.current;
    setSharedNotice(undefined);
    const text = `${companionName}的日记 · ${diaryDate(entry)}\n\n${entry.body}`;
    try {
      if (copy) {
        if (!await setStringAsync(text)) throw new Error("Clipboard unavailable.");
        if (scope === session.current) setSharedNotice({ id: entry.id, message: "日记已复制。" });
      } else if (Platform.OS === "web") {
        await navigator.share({ title: `${companionName}的日记`, text });
      } else {
        await Share.share({ message: text });
      }
    } catch (error) {
      if (scope === session.current && !(error instanceof Error && error.name === "AbortError")) {
        setSharedNotice({ id: entry.id, message: copy ? "复制失败，请重试。" : "分享未完成，请重试。" });
      }
    } finally { sharing.current = false; }
  }

  const refreshDiary = () => void read(undefined, "refresh");
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshDiary} tintColor={ui.accent} colors={[ui.accent]} />}>
      <SecondaryHeading title={`${companionName}的日记`} />

      {companions.length > 1 && onSelectCompanion && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ds.switcher}>
          {companions.map(item => {
            const active = item.companionId === companionId;
            return (
              <Pressable
                key={item.companionId}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => { if (!active) onSelectCompanion(item); }}
                style={[ds.pill, active && ds.pillActive]}
              >
                <PixelAvatar name={item.displayName} role="companion" uri={item.avatar} size={20} />
                <Text style={[ds.pillText, active && ds.pillTextActive]}>{item.displayName}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={s.row}>
        <CommunityButton label={settingsOpen ? "收起日记设置" : "日记设置"} selected={settingsOpen}
          onPress={() => setSettingsOpen(open => !open)} />
        {Platform.OS === "web" && <CommunityButton label={refreshing ? "正在刷新…" : "刷新日记"}
          disabled={loading || loadingOlder || refreshing} onPress={refreshDiary} />}
      </View>
      {settingsOpen && <DiaryFrequency client={client} companionId={companionId} />}
      {writing && <Text accessibilityLiveRegion="polite" style={s.meta}>TA 正在写日记…</Text>}
      {notice !== "" && <Text accessibilityLiveRegion="polite" style={s.meta}>{notice}</Text>}
      {loading && <ActivityIndicator accessibilityLabel="正在读取日记" color={ui.accent} />}
      {readError && <View style={s.card}>
        <Text accessibilityRole="alert" style={s.body}>{readError.title}</Text>
        <CommunityButton label="重新加载" onPress={() => void read(readError.cursor)} />
      </View>}
      {!loading && !writing && !readError && items.length === 0 && <Text style={s.meta}>这里还没有日记。</Text>}
      {items.map(entry => <View key={entry.id} style={s.card}>
        <Text accessibilityRole="header" style={s.author}>
          {diaryDate(entry)}
        </Text>
        <Text style={s.body}>{entry.body}</Text>
        {confirmId === entry.id ? <>
          <Text style={s.meta}>删除后无法恢复。</Text>
          <View style={s.row}>
            <CommunityButton label="确认删除" disabled={deleting} onPress={() => void remove(entry.id)} />
            <CommunityButton label="取消" disabled={deleting} onPress={() => setConfirmId(undefined)} />
          </View>
        </> : <View style={s.row}>
          <CommunityButton label="复制" accessibilityLabel="复制这篇日记" onPress={() => void shareEntry(entry, true)} />
          {canShare && <CommunityButton label="分享" accessibilityLabel="分享这篇日记" onPress={() => void shareEntry(entry, false)} />}
          <CommunityButton label="删除" disabled={deleting} onPress={() => setConfirmId(entry.id)} />
        </View>}
        {sharedNotice?.id === entry.id && <Text accessibilityLiveRegion="polite" style={s.meta}>{sharedNotice.message}</Text>}
      </View>)}
      {cursor && <CommunityButton label={loadingOlder ? "正在加载…" : "更早的日记"} disabled={loading || loadingOlder || refreshing}
        onPress={() => void read(cursor)} />}
    </ScrollView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  switcher: { gap: 8, paddingVertical: 2 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  pillActive: {
    backgroundColor: ui.accentWash,
    borderColor: ui.accent,
  },
  pillText: { fontSize: 13, fontWeight: "600", color: ui.ink },
  pillTextActive: { color: ui.accentInk },
});
