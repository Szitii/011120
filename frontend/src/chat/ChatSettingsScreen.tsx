import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { ChatModelList } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import { AgentKeySettings } from "./AgentKeySettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { MemorySettings } from "./MemorySettings";
import { VoicePicker } from "./VoicePicker";
import type { ChatClient, VoiceList, VoiceSettings } from "./client";

const ACTIVITY = [["QUIET", "安静"], ["NORMAL", "适中"], ["ACTIVE", "活跃"]] as const;
const INTERACTION = [["NONE", "不互动"], ["RARE", "偶尔"], ["NORMAL", "适中"], ["LIVELY", "热络"]] as const;
const TIER = { ECONOMY: "经济", STANDARD: "均衡", PREMIUM: "高级" };

export function ChatSettingsScreen({ client, companionId, connectionKind, connectionsEnabled, onAvailabilityChanged }: {
  client: ChatClient; companionId: string; connectionKind?: "key" | "external";
  connectionsEnabled: boolean; onAvailabilityChanged: () => void;
}) {
  const s = useCommunityStyles();
  const [form, setForm] = useState<VoiceSettings>();
  const [voices, setVoices] = useState<VoiceList>();
  const [voiceChanged, setVoiceChanged] = useState(false);
  const [models, setModels] = useState<ChatModelList>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelError, setModelError] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    setBusy(true);
    setNotice("");
    setVoiceChanged(false);
    setVoices(undefined);
    void client.listVoices?.().then(value => { if (current) setVoices(value); }).catch(() => { /* Older servers omit voices. */ });
    void client.getChatSettings(companionId).then(value => { if (current) setForm(value); })
      .catch(problem => { if (current) setNotice(safeClientMessage(problem).title); })
      .finally(() => { if (current) setBusy(false); });
    setModelError(false);
    void client.listModels?.().then(value => { if (current) setModels(value); })
      .catch(() => { if (current) setModelError(true); });
    return () => { current = false; mounted.current = false; };
  }, [client, companionId, reload]);

  async function save() {
    if (!form || busy || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const { voice, ...settings } = form;
      const saved = await client.updateChatSettings(companionId, voiceChanged && voices?.available ? { ...settings, voice } : settings);
      if (mounted.current) {
        setForm(saved);
        setVoiceChanged(false);
        setNotice("聊天设置已保存。");
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiProblemError && error.status === 409) {
        try {
          const latest = await client.getChatSettings(companionId);
          if (mounted.current) { setForm(latest); setVoiceChanged(false); setNotice("设置已在另一台设备修改，请核对后再保存。"); }
        } catch {
          if (mounted.current) { setForm(undefined); setNotice("无法读取最新设置，请重新加载。"); }
        }
      } else setNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <SecondaryHeading title="聊天设置" />
    {!!notice && <Text accessibilityLiveRegion="polite" style={s.body}>{notice}</Text>}
    {client.saveConnection && <ConnectionSettings client={client} companionId={companionId} initialKind={connectionKind} enabled={connectionsEnabled} onAvailabilityChanged={onAvailabilityChanged} />}
    {client.listAgentKeys && client.createAgentKey && client.revokeAgentKey && <AgentKeySettings
      key={companionId} companionId={companionId} list={client.listAgentKeys} create={client.createAgentKey} revoke={client.revokeAgentKey} />}
    {client.listMemories && <MemorySettings client={client} companionId={companionId} />}
    {!form ? busy ? <ActivityIndicator accessibilityLabel="正在读取聊天设置" />
      : <CommunityButton label="重新加载" onPress={() => setReload(value => value + 1)} />
      : <>
        <View style={s.card}>
          <Text style={s.author}>群聊活跃度</Text>
          <View style={s.row}>{ACTIVITY.map(([value, label]) => <CommunityButton key={value} label={label}
            disabled={busy} selected={form.groupActivity === value} onPress={() => setForm({ ...form, groupActivity: value })} />)}</View>
          <Text style={s.author}>家机互动倾向</Text>
          <View style={s.row}>{INTERACTION.map(([value, label]) => <CommunityButton key={value} label={label}
            disabled={busy} selected={form.companionInteraction === value} onPress={() => setForm({ ...form, companionInteraction: value })} />)}</View>
        </View>
        <View style={s.card}>
          <Text style={s.author}>聊天模型</Text>
          <CommunityButton label="使用平台默认" disabled={busy} selected={form.model === null} onPress={() => setForm({ ...form, model: null })} />
          {models?.items.map(model => <CommunityButton key={model.id}
            label={`${model.name} · ${TIER[model.tier]}${model.available ? "" : " · 暂不可用"}`}
            selected={model.id === form.model} disabled={busy || !model.available} onPress={() => setForm({ ...form, model: model.id })} />)}
          {modelError && <Text style={s.meta}>暂时无法读取模型列表，当前设置仍会保留。</Text>}
        </View>
        {voices?.available && <VoicePicker voices={voices.items} sample={client.voiceSample}
          selected={form.voice} disabled={busy} onSelect={voice => {
            setVoiceChanged(true);
            setForm({ ...form, voice });
          }} />}
        <CommunityButton primary label={busy ? "正在处理…" : "保存设置"} disabled={busy} onPress={() => void save()} />
      </>}
  </ScrollView>;
}
