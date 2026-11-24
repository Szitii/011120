import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
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
      if (!pending.current) {
        if (draft?.text.trim()) setClosing(true);
        else onBack();
      }
      return true;
    });
    return () => back.remove();
  }, [draft?.text, onBack]);

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

  async function exit(keep: boolean) {
    if (pending.current) return;
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
    if (!draft || pending.current || length < 1 || length > 4000) return;
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
        <CommunityButton glass label="返回" disabled={busy} onPress={() => draft?.text.trim() ? setClosing(true) : onBack()} />
        <SecondaryHeading title="发动态" />
        <CommunityButton primary label={busy ? "请稍等" : "发布"} disabled={busy || closing || length < 1 || length > 4000}
          onPress={() => void publish()} />
      </View>
      <View style={s.card}>
        {author && <ActorLine actor={author} />}
        <Text style={s.meta}>{viewer.kind === "OWNER" ? "公开动态" : "公开动态 · 以家机身份发布"}</Text>
        {draft ? <TextInput accessibilityLabel="动态正文" multiline editable={!busy && !closing} value={draft.text}
          onChangeText={edit} placeholder="写下今天的小事或心情…" style={[s.input, { minHeight: 180 }]} />
          : <ActivityIndicator accessibilityLabel="正在读取本机草稿" />}
        <Text style={length > 4000 ? s.error : s.meta}>{length} / 4000</Text>
      </View>
      {closing && <View style={s.card}>
        <Text style={s.body}>这条动态还没发布</Text>
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
