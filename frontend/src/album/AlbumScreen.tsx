import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import type { HomeScope } from "../home/keys";
import { addAlbumPhoto, deleteAlbumEntry, listAlbum, type AlbumEntry } from "./store";
import { findMedia } from "./mediaFiles";

export function AlbumScreen({ scope }: { scope: HomeScope }) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<AlbumEntry[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string>();
  const pending = useRef(false);
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

  return (
    <FlatList
      style={s.page}
      contentContainerStyle={s.content}
      data={items ?? []}
      keyExtractor={item => item.id}
      ListHeaderComponent={<View style={styles.header}>
        <SecondaryHeading title="相册" />
        <Text style={s.meta}>留念保存在当前设备。</Text>
        <CommunityButton label="从相册选图" disabled={busy}
          onPress={() => void change(importPhoto, "照片没保存成功，请再试一次。")} />
        {error !== "" && <View accessibilityRole="alert">
          <Text style={s.body}>{error}</Text>
          <CommunityButton label="重新加载" onPress={() => { setError(""); void refresh(); }} />
        </View>}
      </View>}
      ListEmptyComponent={items ? <Text style={s.meta}>可以在小家拍张照片，或从聊天里留下一句话。</Text>
        : !error ? <ActivityIndicator accessibilityLabel="正在读取相册" /> : undefined}
      renderItem={({ item }) => <View style={s.card}>
        <Text style={s.author}>{item.kind === "room_snapshot" ? "小家拍立得" : item.kind === "local_photo" ? "照片" : "聊天金句"}</Text>
        {item.kind === "chat_quote" ? <Text selectable style={s.body}>{item.quote.text}</Text>
          : <AlbumPhoto path={item.localPath} snapshot={item.kind === "room_snapshot"} />}
        <Text style={s.meta}>
          {item.kind === "chat_quote" ? `${item.quote.speaker} · ` : ""}
          {new Date(item.kind === "chat_quote" ? item.quote.sentAt : item.createdAt).toLocaleDateString("zh-CN")}
        </Text>
        {confirmId === item.id ? <View style={s.row}>
          <CommunityButton label="确认删除" disabled={busy}
            onPress={() => void change(() => deleteAlbumEntry(scope, item.id), "这条留念没能删除。")} />
          <CommunityButton label="取消" disabled={busy} onPress={() => setConfirmId(undefined)} />
        </View> : <CommunityButton label="删除" disabled={busy} onPress={() => setConfirmId(item.id)} />}
      </View>}
    />
  );
}

function AlbumPhoto({ path, snapshot }: { path: string; snapshot: boolean }) {
  const s = useCommunityStyles();
  const [uri, setUri] = useState<string>();
  const [failed, setFailed] = useState(false);
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

  if (failed) return <Text style={s.meta}>这张照片的本地文件已不可读。</Text>;
  if (!uri) return <ActivityIndicator accessibilityLabel="正在读取照片" />;
  return <Image
    accessibilityLabel={snapshot ? "小家拍立得" : "本地照片"}
    source={{ uri }}
    contentFit="contain"
    style={[styles.photo, { aspectRatio: snapshot ? 4 / 5 : 1 }]}
    onError={() => setFailed(true)}
  />;
}

const styles = StyleSheet.create({
  header: { gap: 10, marginBottom: 10 },
  photo: { width: "100%", borderRadius: 12 },
});
