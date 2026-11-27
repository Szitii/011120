import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { setStringAsync } from "expo-clipboard";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import type { HomeScope } from "../home/keys";
import {
  formatAlbumDate,
  formatQuoteShareText,
  type AlbumPhotoKind,
} from "./actions";
import { addAlbumPhoto, deleteAlbumEntry, listAlbum, type AlbumEntry, type QuoteInput } from "./store";
import { exportMedia, findMedia } from "./mediaFiles";

interface InlineFeedback {
  id: string;
  message: string;
  isError: boolean;
}

export function AlbumScreen({ scope }: { scope: HomeScope }) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<AlbumEntry[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string>();
  const [quoteActionKey, setQuoteActionKey] = useState<string>();
  const [quoteFeedback, setQuoteFeedback] = useState<InlineFeedback>();
  const pending = useRef(false);
  const quotePending = useRef(false);
  const active = useRef(false);

  async function refresh() {
    try {
      const entries = await listAlbum(scope);
      if (active.current) setItems(entries);
    } catch {
      if (active.current) setError("相册暂时读不到。");
    }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; };
  }, [scope.ownerId, scope.companionId]);

  async function change(operation: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (active.current) {
        setConfirmId(undefined);
        await refresh();
      }
    } catch {
      if (active.current) setError(failure);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function importPhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (result.canceled || !active.current) return;
    const [asset] = result.assets;
    const extension = asset.fileName?.split(".").at(-1) ?? asset.mimeType?.split("/").at(-1) ?? "jpg";
    await addAlbumPhoto(scope, "local_photo", asset.uri, extension);
  }

  async function copyQuote(entryId: string, quote: QuoteInput) {
    if (quotePending.current) return;
    quotePending.current = true;
    setQuoteActionKey(`${entryId}:copy`);
    setQuoteFeedback(undefined);
    let copied = false;
    try {
      copied = await setStringAsync(formatQuoteShareText(quote));
    } catch {
      copied = false;
    } finally {
      quotePending.current = false;
      if (active.current) {
        setQuoteActionKey(undefined);
        setQuoteFeedback({
          id: entryId,
          message: copied ? "金句已复制到剪贴板。" : "复制失败，请长按文字手动复制。",
          isError: !copied,
        });
      }
    }
  }

  const quoteBusy = quoteActionKey !== undefined;

  return (
    <FlatList
      style={s.page}
      contentContainerStyle={s.content}
      data={items ?? []}
      keyExtractor={item => item.id}
      ListHeaderComponent={<View style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <SecondaryHeading title="相册" />
          <CommunityButton primary label="添加照片" disabled={busy}
            onPress={() => void change(importPhoto, "照片没保存成功，请再试一次。")} />
        </View>
        <Text style={s.meta}>照片和聊天金句都保存在当前设备。</Text>
        {error !== "" && <View accessibilityRole="alert">
          <Text style={s.body}>{error}</Text>
          <CommunityButton label="重新加载" onPress={() => { setError(""); void refresh(); }} />
        </View>}
      </View>}
      ListEmptyComponent={items ? <View style={[s.card, styles.empty]}>
          <Image source={require("../../assets/album-polaroid.png")} style={styles.emptyIcon} contentFit="contain" />
          <Text style={s.author}>还没有留念</Text>
          <Text style={s.meta}>可以在小家拍张照片，或从聊天里留下一句话。</Text>
        </View>
        : !error ? <ActivityIndicator accessibilityLabel="正在读取相册" /> : undefined}
      renderItem={({ item }) => <View style={s.card}>
        <Text style={s.author}>{item.kind === "room_snapshot" ? "小家拍立得" : item.kind === "local_photo" ? "照片" : "聊天金句"}</Text>
        {item.kind === "chat_quote" ? <Text selectable style={s.body}>{item.quote.text}</Text>
          : <AlbumPhoto entryId={item.id} createdAt={item.createdAt} kind={item.kind} path={item.localPath} />}
        <Text style={s.meta}>
          {item.kind === "chat_quote" ? `${item.quote.speaker} · ` : ""}
          {formatAlbumDate(item.kind === "chat_quote" ? item.quote.sentAt : item.createdAt)}
        </Text>
        {confirmId === item.id ? <View style={s.row}>
          <CommunityButton label="确认删除" disabled={busy || quoteBusy}
            onPress={() => void change(() => deleteAlbumEntry(scope, item.id), "这条留念没能删除。")} />
          <CommunityButton label="取消" disabled={busy || quoteBusy} onPress={() => setConfirmId(undefined)} />
        </View> : <View style={s.row}>
          {item.kind === "chat_quote" && <>
            <CommunityButton
              label={quoteActionKey === `${item.id}:copy` ? "复制中…" : "复制"}
              disabled={busy || quoteBusy}
              onPress={() => void copyQuote(item.id, item.quote)}
            />
          </>}
          <CommunityButton label="删除" disabled={busy || quoteBusy} onPress={() => setConfirmId(item.id)} />
        </View>}
        {item.kind === "chat_quote" && quoteFeedback?.id === item.id && (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={quoteFeedback.isError ? "alert" : undefined}
            style={s.meta}
          >
            {quoteFeedback.message}
          </Text>
        )}
      </View>}
    />
  );
}

function AlbumPhoto({
  entryId,
  createdAt,
  kind,
  path,
}: {
  entryId: string;
  createdAt: string;
  kind: AlbumPhotoKind;
  path: string;
}) {
  const s = useCommunityStyles();
  const { ui } = useSkin();
  const [preview, setPreview] = useState(false);
  const [uri, setUri] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{ message: string; isError: boolean }>();
  const exportPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let url: string | undefined;
    function release() { if (Platform.OS === "web" && url) URL.revokeObjectURL(url); }
    void findMedia(path).then(value => {
      url = value;
      if (!active) { release(); return; }
      setUri(value);
      if (!value) setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; release(); };
  }, [path]);

  async function handleWebExport() {
    if (exportPending.current) return;
    exportPending.current = true;
    setExporting(true);
    setExportFeedback(undefined);
    try {
      const result = await exportMedia(path, { kind, createdAt, entryId });
      if (!mounted.current) return;
      if (result.status === "exported") {
        setExportFeedback({ message: `已开始下载：${result.filename}`, isError: false });
      } else if (result.status === "missing") {
        setExportFeedback({ message: "这张照片的本地文件已失效，无法导出。", isError: true });
      } else if (result.status === "denied") {
        setExportFeedback({ message: "未获得相册写入权限，请在系统设置中开启。", isError: true });
      } else if (result.status === "canceled") {
        setExportFeedback(undefined);
      } else if (result.status === "unsupported") {
        setExportFeedback({ message: "当前环境暂不支持导出原图。", isError: true });
      } else {
        setExportFeedback({ message: result.message, isError: true });
      }
    } catch {
      if (mounted.current) setExportFeedback({ message: "照片导出失败，请稍后重试。", isError: true });
    } finally {
      exportPending.current = false;
      if (mounted.current) setExporting(false);
    }
  }

  if (failed) return <Text style={s.meta}>这张照片的本地文件已不可读。</Text>;
  if (!uri) return <ActivityIndicator accessibilityLabel="正在读取照片" />;
  const snapshot = kind === "room_snapshot";
  const label = snapshot ? "小家拍立得" : "本地照片";
  const open = () => {
    setExportFeedback(undefined);
    setPreview(true);
  };
  const close = () => {
    if (exportPending.current) return;
    setPreview(false);
  };
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看大图：${label}`} onPress={open}>
      <Image source={{ uri }} contentFit="contain"
        style={[styles.photo, { aspectRatio: snapshot ? 4 / 5 : 1 }]} onError={() => setFailed(true)} />
    </Pressable>
    <Modal visible={preview} animationType="fade" onRequestClose={close}>
      <SafeAreaView style={[styles.preview, { backgroundColor: ui.background[0] }]} accessibilityViewIsModal>
        <View style={styles.previewBar}>
          <Text accessibilityRole="header" style={s.author}>{label}</Text>
          <View style={styles.previewActions}>
            {Platform.OS === "web" && (
              <CommunityButton
                primary
                label={exporting ? "导出中…" : "下载原图"}
                disabled={exporting}
                onPress={() => void handleWebExport()}
              />
            )}
            <CommunityButton label="关闭大图" disabled={exporting} onPress={close} />
          </View>
        </View>
        {exportFeedback ? (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={exportFeedback.isError ? "alert" : undefined}
            style={[s.meta, styles.previewNotice]}
          >
            {exportFeedback.message}
          </Text>
        ) : Platform.OS !== "web" ? (
          <Text style={[s.meta, styles.previewNotice]}>iOS / Android 分享与保存到系统相册待安装原生依赖后启用。</Text>
        ) : null}
        <Image accessibilityLabel={label} source={{ uri }} contentFit="contain" style={styles.fullPhoto} />
      </SafeAreaView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  header: { gap: 10, marginBottom: 10 },
  photo: { width: "100%", borderRadius: 12 },
  empty: { alignItems: "center", paddingVertical: 24 },
  emptyIcon: { width: 52, height: 50 },
  preview: { flex: 1 },
  previewBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  previewActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  previewNotice: { paddingHorizontal: 16, paddingBottom: 6 },
  fullPhoto: { flex: 1, marginHorizontal: 12, marginBottom: 12 },
});
