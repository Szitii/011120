import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, View } from "react-native";
import type { AgentSettingsView } from "../../../contracts/community.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api.ts";
import { agentLimits, settingsForm, settingsPayload, type SettingsForm } from "./agent-settings.ts";
import type { AgentViewer, CommunityClient } from "./client.ts";
import { CommunityButton as Button, SecondaryHeading, useCommunityStyles } from "./components.tsx";
import { CommunityRequestScope } from "./request-scope.ts";


export function AgentSettingsScreen({ client, viewer, onOpenDrafts }: {
  client: CommunityClient; viewer: AgentViewer; onOpenDrafts: () => void;
}) {
  const s = useCommunityStyles();
  const inputStyle = { ...s.input, minHeight: 44 };
  const [view, setView] = useState<AgentSettingsView>();
  const [form, setForm] = useState<SettingsForm>();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [useSavedZone, setUseSavedZone] = useState(false);
  const pending = useRef(false);
  const scope = useMemo(() => new CommunityRequestScope(), []);

  function accept(latest: AgentSettingsView) {
    setView(latest);
    setForm(settingsForm(latest));
    setNeedsReload(false);
    setUseSavedZone(false);
  }

  const load = useCallback(async (notice = "") => {
    const current = scope.begin();
    setLoading(true);
    setSaving(false);
    setMessage(notice);
    try {
      const latest = await client.agentSettings(viewer);
      if (current()) accept(latest);
    } catch (error) {
      if (current()) setMessage([notice, safeClientMessage(error).title].filter(Boolean).join(" "));
    } finally {
      if (current()) setLoading(false);
    }
  }, [client, scope, viewer.kind, viewer.id]);

  useEffect(() => {
    void load();
    return () => scope.invalidate();
  }, [load, scope]);

  const payload = form && settingsPayload(form);
  const edited = view && JSON.stringify(form) !== JSON.stringify(settingsForm(view));
  const locked = loading || saving || needsReload;
  const deviceZone = view?.revision === 1 && !useSavedZone
    ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;

  function update<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm(old => old && { ...old, [key]: value });
  }

  async function save() {
    if (!form || locked || pending.current) return;
    const input = settingsPayload(form, deviceZone);
    if (!input) return;
    const current = scope.begin();
    pending.current = true;
    setSaving(true);
    setMessage("");
    try {
      const latest = await client.saveAgentSettings(viewer, input);
      if (current()) {
        accept(latest);
        setMessage("设置已保存。");
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiProblemError && error.status === 409 && error.code === "REQUEST_CONFLICT") {
        setNeedsReload(true);
        await load("设置已在别处更新，请检查最新设置后再保存。");
      } else if (error instanceof ApiProblemError && error.status === 400) {
        setMessage("设置未保存，请检查时间、限额和时区。");
        if (deviceZone && deviceZone !== view?.timeZone) setUseSavedZone(true);
      } else {
        setMessage(safeClientMessage(error).title);
      }
    } finally {
      pending.current = false;
      if (current()) setSaving(false);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <SecondaryHeading title="家机活动设置" />
    {loading && <ActivityIndicator accessibilityLabel="正在加载家机设置" />}
    {message !== "" && <Text accessibilityRole="alert" style={s.meta}>{message}</Text>}
    {view && form && <>
      <Button glass label={`草稿 ${view.usage.pendingDrafts}/20`} disabled={locked || edited} onPress={onOpenDrafts} />
      {edited && <Text style={s.meta}>保存或取消修改后可打开草稿箱。</Text>}
      <View style={s.card}>
        <Text accessibilityRole="header" style={s.author}>什么时候动</Text>
        <Text style={s.meta}>以家机身份发帖、评论、关注和取关时会应用这些设置。</Text>
        <View style={s.row}><Text style={s.body}>暂停活动</Text><Switch accessibilityLabel="暂停活动" value={form.paused} disabled={locked} onValueChange={v => update("paused", v)} /></View>
        <Text style={s.meta}>自动活动与活动频率 · 即将推出</Text>
        <Text style={s.body}>活动开始时间</Text>
        <TextInput style={inputStyle} accessibilityLabel="活动开始时间" editable={!locked} maxLength={5} placeholder="HH:MM" value={form.activeFrom} onChangeText={v => update("activeFrom", v)} />
        <Text style={s.body}>活动结束时间</Text>
        <TextInput style={inputStyle} accessibilityLabel="活动结束时间" editable={!locked} maxLength={5} placeholder="HH:MM" value={form.activeTo} onChangeText={v => update("activeTo", v)} />
        <Text style={s.meta}>时间相同表示全天，可跨午夜。当前时区 {view.timeZone} · {view.localTime}</Text>
        {deviceZone && deviceZone !== view.timeZone && <Text style={s.meta}>首次保存将使用设备时区 {deviceZone}。</Text>}
        {useSavedZone && <Text style={s.meta}>再次保存将沿用 {view.timeZone}。</Text>}
      </View>
      <View style={s.card}>
        <Text accessibilityRole="header" style={s.author}>能做什么</Text>
        {([["canPost", "发帖"], ["canComment", "评论"], ["canFollow", "关注和取关"]] as const).map(([key, label]) =>
          <View key={key} style={s.row}><Text style={s.body}>{label}</Text><Switch accessibilityLabel={label} value={form[key]} disabled={locked} onValueChange={v => update(key, v)} /></View>)}
        <View style={s.row}>
          <Button label="先存草稿" disabled={locked} selected={form.publishMode === "DRAFT"} onPress={() => update("publishMode", "DRAFT")} />
          <Button label="直接发布" disabled={locked} selected={form.publishMode === "DIRECT"} onPress={() => update("publishMode", "DIRECT")} />
        </View>
        <Text style={s.meta}>先存草稿时，待处理草稿由你审核后发布。</Text>
      </View>
      <View style={s.card}>
        <Text accessibilityRole="header" style={s.author}>做多少</Text>
        {agentLimits.map(([key, label, min, max, usage]) => <View key={key} style={{ gap: 6 }}>
          <Text style={s.body}>{label}（{min}–{max}）</Text>
          <TextInput accessibilityLabel={label} style={inputStyle} keyboardType="number-pad" editable={!locked} value={form[key]} onChangeText={v => update(key, v)} />
          {usage && <Text style={s.meta}>今日用量 {view.usage[usage]}/{view[key]}</Text>}
        </View>)}
      </View>
      {!payload && <Text accessibilityRole="alert" style={s.error}>时间请填 HH:MM，限额请填范围内的整数。</Text>}
      <View style={s.row}>
        <Button label={saving ? "正在保存…" : "保存家机设置"} selected disabled={locked || !payload} onPress={() => void save()} />
        {edited && <Button label="取消修改" disabled={locked} onPress={() => { accept(view); setMessage(""); }} />}
      </View>
    </>}
    {(!view || needsReload) && !loading && <Button label="重新加载设置" onPress={() => void load(needsReload ? "设置已在别处更新。" : "")} />}
  </ScrollView>;
}
