import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { findMedia, keepMedia, removeMedia } from "../album/mediaFiles";
import { useSkin } from "../theme/SkinProvider";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityPost } from "../../../contracts/community";
import { communityWriteMessage } from "../adapters/real-api";
import { communityRequestKey, type CommunityClient } from "./client";
import { ActorLine, CommunityButton, useCommunityStyles, SecondaryHeading } from "./components";

const MAX_PHOTOS = 4;
type Draft = { text: string; key: string; photos: string[] };

function DraftPhotoPreview({ path }: { path: string }) {
  const s = useCommunityStyles();
  const [uri, setUri] = useState<string>();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let current = true;
    let resolved: string | undefined;
    const release = () => { if (Platform.OS === "web" && resolved) URL.revokeObjectURL(resolved); };
    void findMedia(path).then(value => {
      resolved = value;
      if (!current) { release(); return; }
      if (value) setUri(value);
      else setMissing(true);
    }).catch(() => { if (current) setMissing(true); });
    return () => { current = false; release(); };
  }, [path]);

  return <View style={{ width: 76, height: 76, justifyContent: "center" }}>
    {missing ? <Text style={s.meta}>照片不可读</Text>
      : uri ? <Image source={{ uri }} style={{ width: "100%", height: "100%", borderRadius: 10 }} onError={() => setMissing(true)} />
      : <ActivityIndicator accessibilityLabel="正在读取照片" />}
  </View>;
}

export function ComposePostScreen({ client, viewer, ownerId, onBack, onPublished }: {
  client: CommunityClient;
  viewer: ActorContext;
  ownerId: string;
  onBack: () => void;
  onPublished: (post: CommunityPost) => void;
}) {
  const s = useCommunityStyles();
  const { ui } = useSkin();
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const picking = useRef(false);
  const storageKey = `companion:post-draft:v1:${ownerId}:${viewer.kind}:${viewer.id}`;
  const [draft, setDraft] = useState<Draft>();
  const photos = draft?.photos ?? [];
  const hasContent = Boolean(draft?.text.trim() || photos.length);
  const [author, setAuthor] = useState<Awaited<ReturnType<CommunityClient["profile"]>>>();
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const alive = useRef(false);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    alive.current = true;
    void AsyncStorage.getItem(storageKey).then(raw => {
      if (!alive.current) return;
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object" && "text" in saved && "key" in saved &&
          typeof saved.text === "string" && typeof saved.key === "string") {
        const paths = "photos" in saved && Array.isArray(saved.photos)
          ? saved.photos.filter((path): path is string => typeof path === "string" && /^post-community-[a-z0-9-]+\.[a-z0-9]{1,8}$/.test(path))
          : [];
        setDraft({ text: saved.text, key: saved.key, photos: [...new Set(paths)].slice(0, MAX_PHOTOS) });
      } else setDraft({ text: "", key: communityRequestKey(), photos: [] });
    }).catch(() => {
      if (alive.current) { setDraft({ text: "", key: communityRequestKey(), photos: [] }); setError("本机草稿暂时无法读取。"); }
    });
    void client.profile(viewer).then(value => { if (alive.current) setAuthor(value); }).catch(() => undefined);
    return () => { alive.current = false; };
  }, [storageKey, client, viewer.kind, viewer.id]);

  const requestBack = useCallback(() => {
    if (pending.current || picking.current) return;
    if (closing) {
      setClosing(false);
    } else if (hasContent) {
      Keyboard.dismiss();
      setClosing(true);
    } else onBack();
  }, [closing, hasContent, onBack]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      requestBack();
      return true;
    });
    return () => back.remove();
  }, [requestBack]);

  function persist(next?: Draft) {
    const operation = writes.current.then(() => next && (next.text.trim() || next.photos.length)
      ? AsyncStorage.setItem(storageKey, JSON.stringify(next))
      : AsyncStorage.removeItem(storageKey));
    writes.current = operation.catch(() => undefined);
    return operation;
  }

  function edit(text: string) {
    if (!draft || pending.current || picking.current) return;
    const next = { ...draft, text, key: communityRequestKey() };
    setDraft(next);
    void persist(next).catch(() => { if (alive.current) setError("本机草稿没保存，请保留页面再试。"); });
  }

  async function pickPhotos(camera: boolean) {
    if (!draft || picking.current || pending.current || photos.length >= MAX_PHOTOS) return;
    picking.current = true;
    setBusy(true);
    setError("");
    const added: string[] = [];
    try {
      if (camera && Platform.OS !== "web" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
        if (alive.current) setError("请允许相机权限，或从相册选择。");
        return;
      }
      const available = MAX_PHOTOS - photos.length;
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: available, quality: 0.85 });
      if (!alive.current || result.canceled) return;
      for (const asset of result.assets.slice(0, available)) {
        const extension = (asset.fileName?.split(".").at(-1) ?? asset.mimeType?.split("/").at(-1) ?? "").toLowerCase();
        const suffix = /^[a-z0-9]{1,8}$/.test(extension) ? extension : "jpg";
        const path = `post-${communityRequestKey()}.${suffix}`;
        added.push(path);
        await keepMedia(path, asset.uri);
      }
      const next = { ...draft, photos: [...photos, ...added] };
      await persist(next);
      if (alive.current) setDraft(next);
    } catch {
      await Promise.allSettled(added.map(removeMedia));
      if (alive.current) setError("照片没能存到本机草稿，请再试一次。");
    } finally {
      picking.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function removePhoto(path: string) {
    if (!draft || pending.current || picking.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = { ...draft, photos: photos.filter(photo => photo !== path) };
      await persist(next);
      if (alive.current) setDraft(next);
      await removeMedia(path).catch(() => undefined);
    } catch {
      if (alive.current) setError("没能移除照片，请再试一次。");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function exit(keep: boolean) {
    if (pending.current || picking.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await persist(keep ? draft : undefined);
      if (!keep) await Promise.allSettled(photos.map(removeMedia));
      if (alive.current) onBack();
    } catch {
      if (alive.current) setError("本机草稿没保存，请再试一次。");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const length = Array.from(draft?.text.trim() ?? "").length;
  async function publish() {
    if (!draft || pending.current || picking.current || photos.length || length < 1 || length > 4000) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const post = await client.publish(viewer, draft.text, draft.key);
      await persist().catch(() => undefined);
      if (alive.current) onPublished(post);
    } catch (problem) {
      if (alive.current) setError(communityWriteMessage(problem, viewer.kind, "发帖"));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <KeyboardAvoidingView style={s.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <CommunityButton glass label="返回" disabled={busy || !draft} onPress={requestBack} />
        <SecondaryHeading title="发动态" />
        <CommunityButton primary label={busy ? "请稍等" : "发布"} disabled={busy || closing || photos.length > 0 || length < 1 || length > 4000}
          onPress={() => void publish()} />
      </View>
      {closing && <View style={s.card}>
        <Text style={s.body}>这条动态还没发布</Text>
        {photos.length > 0 && <Text style={s.meta}>照片会和正文一起保存在当前设备。</Text>}
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <CommunityButton label="继续编辑" disabled={busy} onPress={() => setClosing(false)} />
          <CommunityButton label="存到本机" disabled={busy} onPress={() => void exit(true)} />
          <CommunityButton label="丢弃" disabled={busy} onPress={() => void exit(false)} />
        </View>
      </View>}
      <View style={s.card}>
        {author && <ActorLine actor={author} />}
        <View style={s.row}>
          <Ionicons name="globe-outline" size={16} color={ui.muted} />
          <Text style={s.meta}>{viewer.kind === "OWNER" ? "所有人可见" : "所有人可见 · 以家机身份发布"}</Text>
        </View>
        {draft ? <TextInput ref={input} accessibilityLabel="动态正文" multiline editable={!busy && !closing} value={draft.text}
          onChangeText={edit} placeholder="写下今天的小事或心情…" placeholderTextColor={ui.placeholder}
          style={[s.input, { minHeight: 124, borderWidth: 0, paddingHorizontal: 0 }]} />
          : <ActivityIndicator accessibilityLabel="正在读取本机草稿" />}
        {photos.length > 0 && <>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            {photos.map((photo, index) => <View key={photo} style={{ position: "relative" }}>
              <DraftPhotoPreview path={photo} />
              <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张照片`} hitSlop={5}
                disabled={busy || closing} style={{ position: "absolute", top: 1, right: 1, backgroundColor: ui.white, borderRadius: 14 }}
                onPress={() => void removePhoto(photo)}>
                <Ionicons name="close-circle-outline" size={23} color={ui.ink} />
              </Pressable>
            </View>)}
          </View>
          <Text style={s.meta}>图片仅供预览，移除后可发布文字动态。</Text>
        </>}
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <CommunityButton label="照片" disabled={busy || closing || !draft || photos.length >= MAX_PHOTOS} onPress={() => void pickPhotos(false)} />
          <CommunityButton label="拍照" disabled={busy || closing || !draft || photos.length >= MAX_PHOTOS} onPress={() => void pickPhotos(true)} />
          {(["#", "@"] as const).map(symbol => <CommunityButton key={symbol} label={symbol} disabled={busy || closing || !draft}
            onPress={() => {
              if (!draft) return;
              edit(draft.text + (draft.text && !/\s$/.test(draft.text) ? " " : "") + symbol);
              input.current?.focus();
            }} />)}
        </View>
        <Text style={length > 4000 ? s.error : s.meta}>{length} / 4000</Text>
        {draft && /[#@]/.test(draft.text) && <Text style={s.meta}># 和 @ 会作为正文发布。</Text>}
      </View>
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    </ScrollView>
  </KeyboardAvoidingView>;
}
