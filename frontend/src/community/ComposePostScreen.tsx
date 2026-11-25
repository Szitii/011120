import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { findMedia, keepMedia, removeMedia } from "../album/mediaFiles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { ActorContext, CommunityPost, PostVisibility } from "../../../contracts/community";
import { communityWriteMessage } from "../adapters/real-api";
import { BottomSheet } from "../components/BottomSheet";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { communityRequestKey, type CommunityClient } from "./client";
import { ActorLine, CommunityButton, POST_VISIBILITY_LABELS } from "./components";
import { MAX_MENTIONS, MentionChips, MentionPicker, type Mention } from "./MentionPicker";

const MAX_PHOTOS = 9;
const VISIBILITIES = ["PUBLIC", "FOLLOWERS", "PRIVATE"] as const;
type Draft = { text: string; key: string; photos: string[]; visibility: PostVisibility; mentions: Mention[] };

function hasDraftContent(draft?: Draft) {
  return Boolean(draft && (draft.text.trim() || draft.photos.length || draft.mentions.length || draft.visibility !== "PUBLIC"));
}

function readMentions(value: unknown): Mention[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, Mention>();
  for (const item of value) {
    if (item && typeof item.id === "string" && typeof item.displayName === "string" && typeof item.handle === "string") {
      entries.set(item.id, { id: item.id, displayName: item.displayName, handle: item.handle });
    }
  }
  return [...entries.values()].slice(0, MAX_MENTIONS);
}
function DraftPhotoPreview({ path }: { path: string }) {
  const { ui } = useSkin();
  const [uri, setUri] = useState<string>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let active = true;
    let resolved: string | undefined;
    const release = () => { if (Platform.OS === "web" && resolved) URL.revokeObjectURL(resolved); };
    void findMedia(path).then(value => {
      resolved = value;
      if (!active) { release(); return; }
      if (value) setUri(value); else setMissing(true);
    }).catch(() => { if (active) setMissing(true); });
    return () => { active = false; release(); };
  }, [path]);
  return <View style={{ width: 82, height: 82, justifyContent: "center" }}>
    {missing ? <Text style={{ color: ui.muted }}>照片不可读</Text>
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
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const storageKey = `companion:post-draft:v1:${ownerId}:${viewer.kind}:${viewer.id}`;
  const [draft, setDraft] = useState<Draft>();
  const photos = draft?.photos ?? [];
  const hasContent = hasDraftContent(draft);
  const picking = useRef(false);
  const [author, setAuthor] = useState<Awaited<ReturnType<CommunityClient["profile"]>>>();
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const alive = useRef(false);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    alive.current = true;
    let current = true;
    const empty = (): Draft => ({ text: "", key: communityRequestKey(), photos: [], visibility: "PUBLIC", mentions: [] });
    void AsyncStorage.getItem(storageKey).then(raw => {
      if (!current) return;
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object" && "text" in saved && "key" in saved &&
          typeof saved.text === "string" && typeof saved.key === "string") {
        const paths = "photos" in saved && Array.isArray(saved.photos)
          ? saved.photos.filter((path): path is string => typeof path === "string" && /^post-community-[a-z0-9-]+\.[a-z0-9]{1,8}$/.test(path)) : [];
        const rawVisibility = "visibility" in saved ? saved.visibility : undefined;
        const visibility = rawVisibility === undefined ? "PUBLIC"
          : VISIBILITIES.find(value => value === rawVisibility) ?? "PRIVATE";
        setDraft({ text: saved.text, key: saved.key, photos: [...new Set(paths)].slice(0, MAX_PHOTOS),
          visibility, mentions: readMentions("mentions" in saved ? saved.mentions : undefined) });
      } else setDraft(empty());
    }).catch(() => {
      if (current) { setDraft(empty()); setError("本机草稿暂时无法读取。"); }
    });
    void client.profile(viewer).then(value => { if (current) setAuthor(value); }).catch(() => undefined);
    return () => { alive.current = false; current = false; };
  }, [storageKey, client, viewer.kind, viewer.id]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!pending.current && !picking.current) {
        if (closing) setClosing(false);
        else if (hasContent) { Keyboard.dismiss(); setClosing(true); }
        else onBack();
      }
      return true;
    });
    return () => back.remove();
  }, [hasContent, closing, onBack]);

  function persist(next?: Draft) {
    const operation = writes.current.then(() => next && hasDraftContent(next)
      ? AsyncStorage.setItem(storageKey, JSON.stringify(next))
      : AsyncStorage.removeItem(storageKey));
    writes.current = operation.catch(() => undefined);
    return operation;
  }

  function edit(options: Partial<Pick<Draft, "text" | "visibility" | "mentions">>) {
    if (!draft || pending.current || picking.current) return;
    const next = { ...draft, ...options, key: communityRequestKey() };
    setDraft(next);
    void persist(next).catch(() => { if (alive.current) setError("草稿未保存，请保留页面再试。"); });
  }

  async function pickPhotos(camera: boolean) {
    if (!draft || pending.current || picking.current || photos.length >= MAX_PHOTOS) return;
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
      if (!alive.current) { await Promise.allSettled(added.map(removeMedia)); return; }
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
    try {
      const next = { ...draft, photos: photos.filter(photo => photo !== path) };
      await persist(next);
      if (alive.current) setDraft(next);
      await removeMedia(path).catch(() => undefined);
    } catch { if (alive.current) setError("照片未移除，请重试。"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
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
      if (alive.current) setError("草稿未保存，请再试一次。");
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const length = Array.from(draft?.text.trim() ?? "").length;
  const canPublish = !busy && !closing && photos.length === 0 && length >= 1 && length <= 4000;

  async function publish() {
    if (!draft || pending.current || picking.current || photos.length || length < 1 || length > 4000) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const post = await client.publish(viewer, draft.text, draft.key, {
        visibility: draft.visibility,
        mentions: draft.mentions.map(mention => mention.id),
      });
      if (draft.visibility !== "PUBLIC" && post.visibility !== draft.visibility) {
        if (alive.current) setError("服务端返回的可见范围与你选择的不一致。请先核对动态，草稿已保留。");
        return;
      }
      await persist().catch(() => undefined);
      if (alive.current) onPublished(post);
    } catch (problem) {
      if (alive.current) setError(communityWriteMessage(problem, viewer.kind, "发帖"));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.header}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !draft}
          onPress={() => { if (hasContent) { Keyboard.dismiss(); setClosing(true); } else onBack(); }}
          style={({ pressed }) => [s.cancelBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={s.cancelText}>取消</Text>
        </Pressable>
        <Text accessibilityRole="header" style={s.headerTitle}>发动态</Text>
        <Pressable
          accessibilityRole="button"
          disabled={!canPublish}
          onPress={() => void publish()}
          style={({ pressed }) => [
            s.publishBtn,
            !canPublish && s.publishBtnDisabled,
            pressed && canPublish && { opacity: 0.85 },
          ]}
        >
          <Text style={s.publishText}>{busy ? "发布中" : "发布"}</Text>
        </Pressable>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.editorCard}>
          <View style={s.authorRow}>
            {author ? <ActorLine actor={author} /> : <View />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`可见范围：${POST_VISIBILITY_LABELS[draft?.visibility ?? "PUBLIC"]}`}
              disabled={busy || closing || !draft}
              onPress={() => { Keyboard.dismiss(); setVisibilityOpen(true); }}
              style={s.visibilityPill}
            >
              <Ionicons name="globe-outline" size={13} color={ui.accentInk} />
              <Text style={s.visibilityText}>
                {POST_VISIBILITY_LABELS[draft?.visibility ?? "PUBLIC"]}
              </Text>
              <Ionicons name="chevron-down" size={13} color={ui.accentInk} />
            </Pressable>
          </View>

          {draft ? (
            <TextInput
              accessibilityLabel="动态正文"
              multiline
              editable={!busy && !closing}
              value={draft.text}
              onChangeText={text => edit({ text })}
              placeholder="分享今天的小事和心情…"
              placeholderTextColor={ui.muted}
              style={s.textInput}
            />
          ) : (
            <ActivityIndicator accessibilityLabel="正在读取草稿" color={ui.accent} style={{ marginVertical: 24 }} />
          )}
          {photos.length > 0 && <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {photos.map((photo, index) => <View key={photo} style={{ position: "relative" }}>
                <DraftPhotoPreview path={photo} />
                <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张照片`}
                  disabled={busy || closing} style={{ position: "absolute", top: 1, right: 1, backgroundColor: ui.white, borderRadius: 14 }}
                  onPress={() => void removePhoto(photo)}><Ionicons name="close-circle-outline" size={23} color={ui.ink} /></Pressable>
              </View>)}
            </View>
            <Text style={s.noticeText}>照片仅保存在本机草稿；目前移除照片后才能发布文字动态。</Text>
          </>}
          {draft && <MentionChips mentions={draft.mentions} disabled={busy || closing}
            onRemove={id => edit({ mentions: draft.mentions.filter(mention => mention.id !== id) })} />}
        </View>

        {!!error && <Text accessibilityRole="alert" style={s.errorText}>{error}</Text>}
      </ScrollView>

      <View style={s.toolbar}>
        <View style={s.toolbarLeft}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加照片"
            disabled={busy || closing || !draft || photos.length >= MAX_PHOTOS}
            onPress={() => void pickPhotos(false)}
            style={s.toolBtn}
          >
            <Ionicons name="image-outline" size={22} color={ui.accentInk} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="拍照"
            disabled={busy || closing || !draft || photos.length >= MAX_PHOTOS}
            onPress={() => void pickPhotos(true)}
            style={s.toolBtn}
          >
            <Ionicons name="camera-outline" size={22} color={ui.accentInk} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加话题"
            disabled={busy || closing || !draft}
            onPress={() => { if (draft) edit({ text: `${draft.text}#` }); }}
            style={s.toolBtn}
          >
            <Text style={s.toolGlyph}>#</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="提及"
            disabled={busy || closing || !draft || !author}
            onPress={() => { Keyboard.dismiss(); setMentionOpen(true); }}
            style={s.toolBtn}
          >
            <Text style={s.toolGlyph}>@</Text>
          </Pressable>
        </View>
        <Text style={length > 4000 ? s.errorText : s.counter}>{length} / 4000</Text>
      </View>

      {mentionOpen && author && draft && <MentionPicker client={client} viewer={viewer} selfId={author.id}
        selected={draft.mentions} onChange={mentions => edit({ mentions })} onClose={() => setMentionOpen(false)} />}

      <BottomSheet visible={visibilityOpen} title="谁可以看这条动态？" onClose={() => setVisibilityOpen(false)}>
        <View style={s.sheetActions}>
          {VISIBILITIES.map(visibility => (
            <CommunityButton key={visibility} label={POST_VISIBILITY_LABELS[visibility]} selected={draft?.visibility === visibility}
              onPress={() => {
                if (draft && draft.visibility !== visibility) edit({ visibility });
                setVisibilityOpen(false);
              }} />
          ))}
          <Text style={s.sheetHint}>仅当前身份可见时，切换到其他身份也看不到这条动态。</Text>
        </View>
      </BottomSheet>

      <BottomSheet visible={closing} title="这条动态还没发布" onClose={() => { if (!busy) setClosing(false); }}>
        <View style={s.sheetActions}>
          <Text style={s.sheetHint}>保存后下次进入发动态页可继续编辑。</Text>
          <CommunityButton primary label="存为草稿" disabled={busy} onPress={() => void exit(true)} />
          <CommunityButton label="不保存，直接离开" disabled={busy} onPress={() => void exit(false)} />
          <CommunityButton label="继续编辑" disabled={busy} onPress={() => setClosing(false)} />
        </View>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: 10,
  },
  cancelBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  cancelText: { fontSize: 15, color: ui.muted, fontWeight: "500" },
  headerTitle: { fontSize: 16.5, fontWeight: "700", color: ui.ink },
  publishBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
  },
  publishBtnDisabled: { backgroundColor: ui.accentWash },
  publishText: { fontSize: 14, fontWeight: "700", color: ui.onAccent },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: 24,
    gap: 12,
  },
  editorCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    padding: 16,
    gap: 14,
    minHeight: 260,
  },
  authorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  visibilityPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accentWash,
  },
  visibilityText: { fontSize: 12, fontWeight: "600", color: ui.accentInk },
  textInput: {
    minHeight: 170,
    fontSize: 15.5,
    lineHeight: 23,
    color: ui.ink,
    textAlignVertical: "top",
  },
  noticeText: { fontSize: 12.5, color: ui.accentInk, paddingHorizontal: 4 },
  errorText: { fontSize: 12.5, color: ui.danger, paddingHorizontal: 4 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 20 : 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ui.line,
    backgroundColor: ui.white,
  },
  toolbarLeft: { flexDirection: "row", alignItems: "center", gap: 18 },
  toolBtn: { padding: 4 },
  toolGlyph: { fontSize: 19, fontWeight: "600", color: ui.accentInk },
  counter: { fontSize: 12.5, color: ui.muted },
  sheetActions: { gap: 10 },
  sheetHint: { fontSize: 13, color: ui.muted, marginBottom: 4 },
});
