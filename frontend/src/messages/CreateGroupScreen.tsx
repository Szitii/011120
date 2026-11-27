import { useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { Chat } from "../../../contracts/chat";
import type { OwnerCompanionSummary } from "../contracts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { makeIdempotencyKey, type ChatClient } from "../chat/client";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";

export function CreateGroupScreen({ client, companions, enabled, featureLoadNotice, retryFeatures, onAvailabilityChanged, onCreated }: {
  client: ChatClient;
  companions: OwnerCompanionSummary[];
  enabled: boolean;
  featureLoadNotice?: string;
  retryFeatures?: () => void;
  onAvailabilityChanged: () => void;
  onCreated: (chat: Chat) => void;
}) {
  const s = useCommunityStyles();
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = useRef<{ payload: string; key: string } | undefined>(undefined);
  const count = Array.from(title.trim()).length;

  async function create() {
    if (!enabled || pending.current || ids.length < 2 || ids.length > 8 || count > 40) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const payload = JSON.stringify([ids, title.trim()]);
    if (request.current?.payload !== payload) request.current = { payload, key: makeIdempotencyKey("group-open") };
    try {
      onCreated(await client.openChat(ids, title.trim() || undefined, request.current.key));
    } catch (problem) {
      if (problem instanceof ApiProblemError && problem.status === 409 && problem.code === "INVALID_STATE") {
        onAvailabilityChanged();
        setError("暂时无法创建群聊，请稍后再试。");
      } else setError(safeClientMessage(problem).title);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <SecondaryHeading title="新建群聊" />
    {!enabled ? <>
      <Text style={s.meta}>{featureLoadNotice ?? "新建群聊暂未开放。"}</Text>
      {retryFeatures && <CommunityButton label="重试读取功能状态" onPress={retryFeatures} />}
    </> : <>
      <Text style={s.meta}>从自己的家机中选 2–8 位。已选 {ids.length} 位</Text>
      <View style={s.card}>
        <TextInput accessibilityLabel="群聊名称" placeholder="群聊名称（可选）" value={title} onChangeText={setTitle} editable={!busy} style={s.input} />
        {count > 40 && <Text style={s.error}>群聊名称最多 40 字。</Text>}
      </View>
      {companions.map(item => <View key={item.companionId} style={s.card}>
        <CommunityButton label={item.displayName} selected={ids.includes(item.companionId)}
          disabled={busy || ids.length >= 8 && !ids.includes(item.companionId)}
          onPress={() => setIds(current => current.includes(item.companionId)
            ? current.filter(id => id !== item.companionId) : [...current, item.companionId])} />
      </View>)}
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      <CommunityButton primary label={busy ? "正在创建…" : "创建群聊"} disabled={busy || ids.length < 2 || count > 40}
        onPress={() => void create()} />
    </>}
  </ScrollView>;
}
