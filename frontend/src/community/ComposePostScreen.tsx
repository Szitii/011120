import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useSkin } from "../theme/SkinProvider";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityPost } from "../../../contracts/community";
import { communityWriteMessage } from "../adapters/real-api";
import { communityRequestKey, type CommunityClient } from "./client";
import { ActorLine, CommunityButton, useCommunityStyles, SecondaryHeading } from "./components";

type Draft = { text: string; key: string };

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
  const [photos, setPhotos] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const storageKey = `companion:post-draft:v1:${ownerId}:${viewer.kind}:${viewer.id}`;
  const [draft, setDraft] = useState<Draft>();
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
          typeof saved.text === "string" && typeof saved.key === "string") setDraft({ text: saved.text, key: saved.key });
      else setDraft({ text: "", key: communityRequestKey() });
    }).catch(() => {
      if (alive.current) { setDraft({ text: "", key: communityRequestKey() }); setError("本机草稿暂时无法读取。"); }
    });
    void client.profile(viewer).then(value => { if (alive.current) setAuthor(value); }).catch(() => undefined);
    return () => { alive.current = false; };
  }, [storageKey, client, viewer.kind, viewer.id]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!pending.current && !picking.current) {
        if (draft?.text.trim() || photos.length) setClosing(true);
        else onBack();
      }
      return true;
    });
    return () => back.remove();
  }, [draft?.text, photos.length, onBack]);

  function persist(next?: Draft) {
    const operation = writes.current.then(() => next?.text.trim()
      ? AsyncStorage.setItem(storageKey, JSON.stringify(next))
      : AsyncStorage.removeItem(storageKey));
    writes.current = operation.catch(() => undefined);
    return operation;
  }

  function edit(text: string) {
    const next = { text, key: communityRequestKey() };
    setDraft(next);
    void persist(next).catch(() => { if (alive.current) setError("本机草稿没保存，请保留页面再试。"); });
  }

  async function pickPhotos(camera: boolean) {
    if (picking.current || pending.current || photos.length >= 4) return;
    picking.current = true;
    setError("");
    try {
      if (camera && Platform.OS !== "web" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
        if (alive.current) setError("请允许相机权限，或从相册选择。");
        return;
      }
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 4 - photos.length, quality: 0.85 });
      if (alive.current && !result.canceled) setPhotos(previous => [...previous, ...result.assets].slice(0, 4));
    } catch {
      if (alive.current) setError(camera ? "相机暂时打不开。" : "相册暂时打不开。");
    } finally {
      picking.current = false;
    }
  }

  async function exit(keep: boolean) {
    if (pending.current || picking.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await persist(keep ? draft : undefined);
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
        <CommunityButton glass label="返回" disabled={busy} onPress={() => (draft?.text.trim() || photos.length) ? setClosing(true) : onBack()} />
        <SecondaryHeading title="发动态" />
        <CommunityButton primary label={busy ? "请稍等" : "发布"} disabled={busy || closing || photos.length > 0 || length < 1 || length > 4000}
          onPress={() => void publish()} />
      </View>
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
            {photos.map((photo, index) => <View key={index} style={{ position: "relative" }}>
              <Image source={{ uri: photo.uri }} style={{ width: 76, height: 76, borderRadius: 10 }} />
              <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张照片`} hitSlop={5}
                disabled={closing} style={{ position: "absolute", top: 1, right: 1, backgroundColor: ui.white, borderRadius: 14 }}
                onPress={() => setPhotos(items => items.filter((_, photoIndex) => index !== photoIndex))}>
                <Ionicons name="close-circle-outline" size={23} color={ui.ink} />
              </Pressable>
            </View>)}
          </View>
          <Text style={s.meta}>图片仅供预览，移除后可发布文字动态。</Text>
        </>}
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <CommunityButton label="照片" disabled={busy || closing || photos.length >= 4} onPress={() => void pickPhotos(false)} />
          <CommunityButton label="拍照" disabled={busy || closing || photos.length >= 4} onPress={() => void pickPhotos(true)} />
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
      {closing && <View style={s.card}>
        <Text style={s.body}>这条动态还没发布</Text>
        {photos.length > 0 && <Text style={s.meta}>存到本机只会保留文字，图片预览会清除。</Text>}
        <View style={s.row}>
          <CommunityButton label="继续编辑" disabled={busy} onPress={() => setClosing(false)} />
          <CommunityButton label="存到本机" disabled={busy} onPress={() => void exit(true)} />
          <CommunityButton label="丢弃" disabled={busy} onPress={() => void exit(false)} />
        </View>
      </View>}
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    </ScrollView>
  </KeyboardAvoidingView>;
}
