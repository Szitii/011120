import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { BringButton, BringField, Check, GlassCard } from "./BringControls";
import { providerPresets, testAndConnectExternal, testAndEnableApiKey, type ProviderId } from "./connection-client";

const providers = Object.keys(providerPresets) as Array<keyof typeof providerPresets>;

export function ConnectionForm({ kind, onPlatform }: { kind: "key" | "external"; onPlatform: () => void }) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [chooseProvider, setChooseProvider] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("");
  const [editModel, setEditModel] = useState(false);
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof testAndEnableApiKey>>();

  function selectProvider(id: ProviderId) {
    setProvider(id);
    setChooseProvider(false);
    setModel(id === "custom" ? "" : providerPresets[id].model);
    setEditModel(id === "custom");
    setEndpoint("");
    setSecret("");
    setShowKey(false);
    setConsent(false);
    setResult(undefined);
  }

  function submit() {
    const outcome = kind === "key"
      ? testAndEnableApiKey({ provider, baseUrl: endpoint, apiKey: secret, model, consent })
      : testAndConnectExternal({ name, endpoint, bearerToken: secret, consent });
    setResult(outcome);
    if (outcome.status === "UNAVAILABLE") {
      setSecret("");
      setShowKey(false);
    }
  }

  const preset = provider && provider !== "custom" ? providerPresets[provider] : null;
  const urlInput = <BringField label="接口地址（HTTPS）" placeholder="请输入 HTTPS 接口地址" value={endpoint}
    onChangeText={value => { setEndpoint(value); setConsent(false); setResult(undefined); }}
    autoCapitalize="none" autoCorrect={false} keyboardType="url" />;

  return <>
    <GlassCard>
      {kind === "key" ? <>
        <Text style={s.label}>1. 选择服务商</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: chooseProvider }}
          onPress={() => setChooseProvider(value => !value)} style={s.dropdown}>
          <Text style={s.body}>
            {provider === "custom" ? "自定义" : preset?.label ?? "选择服务商（已预设官方地址）"}
          </Text>
          <Ionicons name={chooseProvider ? "chevron-up" : "chevron-down"} size={17} color={ui.accentInk} />
        </Pressable>
        {chooseProvider && <View style={s.options} accessibilityRole="radiogroup">
          {providers.map(id => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: provider === id }}
            style={s.option} onPress={() => selectProvider(id)}>
            <Text style={s.label}>{providerPresets[id].label}</Text>
            {provider === id && <Ionicons name="checkmark" size={18} color={ui.accentInk} />}
          </Pressable>)}
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: provider === "custom" }}
            style={s.option} onPress={() => selectProvider("custom")}>
            <Text style={s.label}>自定义（兼容接口）</Text>
          </Pressable>
        </View>}
        {provider === "custom" && urlInput}
        <View style={s.secret}>
          <BringField label="2. 粘贴 API Key" placeholder="请输入 API Key" value={secret}
            onChangeText={value => { setSecret(value); setResult(undefined); }}
            secureTextEntry={!showKey} autoCapitalize="none" autoCorrect={false} autoComplete="off" style={s.secretField} />
          <Pressable accessibilityRole="button" accessibilityLabel={showKey ? "隐藏密钥" : "显示密钥"}
            onPress={() => setShowKey(value => !value)} style={s.eye}>
            <Ionicons name={showKey ? "eye-off-outline" : "eye-outline"} size={20} color={ui.accentInk} />
          </Pressable>
        </View>
        <View style={s.modelRow}>
          <Text style={[s.body, s.model]} numberOfLines={2}>{preset && model === preset.model
            ? "推荐模型 · 已自动匹配" : model || "推荐模型 · 待选择"}</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: editModel }} disabled={!provider}
            onPress={() => setEditModel(value => !value)} style={s.changeModel}>
            <Text style={s.link}>更换模型 ›</Text>
          </Pressable>
        </View>
        {editModel && <BringField label="模型名称" placeholder="请输入模型名称" value={model}
          onChangeText={value => { setModel(value); setResult(undefined); }} autoCapitalize="none" autoCorrect={false} />}
      </> : <>
        <BringField label="家机名称" placeholder="请输入家机名称" value={name}
          onChangeText={value => { setName(value); setResult(undefined); }} maxLength={200} />
        {urlInput}
        <BringField label="访问密钥（Bearer Token）" placeholder="选填" value={secret}
          onChangeText={value => { setSecret(value); setResult(undefined); }}
          secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" />
      </>}
    </GlassCard>
    {kind === "external" && <Text style={s.notice}>直连后由你自己的服务端驱动，不消耗平台对话额度</Text>}
    <Check checked={consent} onPress={() => { setConsent(value => !value); setResult(undefined); }}
      label={kind === "key"
        ? "单聊时会将近期对话与人设发往你选择的服务商；测试期间仅发验证消息，不传真实聊天。"
        : "已知晓对话请求将直接发往我填写的外部接口"} />
    {result && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.notice}>{result.message}</Text>}
    <BringButton label={kind === "key" ? "测试并启用" : "测试并连通"} onPress={submit} />
    {result?.status === "UNAVAILABLE" && <BringButton label={kind === "key" ? "返回平台托管" : "返回接入方式"}
      secondary onPress={onPlatform} />}
  </>;
}

function createStyles(ui: UiPalette) {
  return StyleSheet.create({
    label: { color: ui.ink, fontSize: 14, fontWeight: "600" },
    body: { color: ui.muted, fontSize: 14 },
    dropdown: { justifyContent: "space-between", flexDirection: "row", alignItems: "center", minHeight: 46,
      paddingHorizontal: 12, borderWidth: 1, borderColor: ui.line, borderRadius: 14, backgroundColor: ui.white },
    options: { borderWidth: 1, borderColor: ui.line, borderRadius: 14, backgroundColor: ui.white },
    option: { minHeight: 44, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12 },
    secret: { position: "relative" },
    secretField: { paddingRight: 48 },
    eye: { position: "absolute", bottom: 1, right: 1, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    modelRow: { borderTopWidth: 1, borderTopColor: ui.line, flexDirection: "row", alignItems: "center", gap: 8 },
    model: { flex: 1 },
    changeModel: { minHeight: 44, justifyContent: "center" },
    link: { color: ui.accentInk, fontSize: 14, fontWeight: "600" },
    notice: { backgroundColor: ui.accentWash, color: ui.accentInk, padding: 12, borderRadius: 14, fontSize: 14, lineHeight: 21 },
  });
}
