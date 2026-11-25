import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { AppState, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { BringButton, BringField, Check, GlassCard } from "./BringControls";
import type { ConnectionInput } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { connectionMessage, providerPresets, validateExternal, validateApiKey, type ConnectionFeedback, type ProviderId } from "./connection-client";

const providers = Object.keys(providerPresets) as Array<keyof typeof providerPresets>;

export function ConnectionForm({ kind, onClose, closeLabel = "返回连接设置", handleBack = false, submitConnection }: {
  kind: "key" | "external";
  onClose: () => void;
  closeLabel?: string;
  handleBack?: boolean;
  submitConnection: (input: ConnectionInput) => Promise<ConnectionFeedback>;
}) {
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
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "background") return;
      setSecret("");
      setShowKey(false);
    });
    return () => {
      mounted.current = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!handleBack) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!pending.current) onClose();
      return true;
    });
    return () => listener.remove();
  }, [handleBack, onClose]);

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

  async function submit() {
    if (pending.current) return;
    const outcome = kind === "key"
      ? validateApiKey({ provider, baseUrl: endpoint, apiKey: secret, model, consent })
      : validateExternal({ name, endpoint, bearerToken: secret, consent });
    if (outcome.status !== "READY") {
      setResult(outcome.message);
      return;
    }
    pending.current = true;
    setBusy(true);
    setResult(undefined);
    setShowKey(false);
    try {
      const outcomeResult = await submitConnection(outcome.input);
      if (mounted.current) {
        if (outcomeResult.result === "CONNECTED") setSecret("");
        setResult(connectionMessage(outcomeResult, kind));
      }
    } catch (error) {
      if (!mounted.current) return;
      setResult(error instanceof ApiProblemError && error.status === 501 ? "线上暂未开放模型连接。你可以先返回使用平台托管。"
        : error instanceof ApiProblemError && error.status === 429 ? "测试次数已达上限，请稍后再试。"
        : safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const preset = provider && provider !== "custom" ? providerPresets[provider] : null;
  const urlInput = <BringField label={kind === "external" ? "完整接口地址（HTTPS）" : "服务商基础地址（HTTPS）"}
    placeholder={kind === "external" ? "请输入完整 HTTPS 接口地址" : "请输入 HTTPS 基础地址"} editable={!busy} value={endpoint}
    onChangeText={value => { setEndpoint(value); setConsent(false); setResult(undefined); }}
    autoCapitalize="none" autoCorrect={false} keyboardType="url" />;

  return <>
    <GlassCard>
      {kind === "key" ? <>
        <Text style={s.label}>1. 选择服务商</Text>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityState={{ expanded: chooseProvider }}
          onPress={() => setChooseProvider(value => !value)} style={s.dropdown}>
          <Text style={s.body}>
            {provider === "custom" ? "自定义" : preset?.label ?? "选择服务商（已预设官方地址）"}
          </Text>
          <Ionicons name={chooseProvider ? "chevron-up" : "chevron-down"} size={17} color={ui.accentInk} />
        </Pressable>
        {chooseProvider && <View style={s.options} accessibilityRole="radiogroup">
          {providers.map(id => <Pressable key={id} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: provider === id }}
            style={s.option} onPress={() => selectProvider(id)}>
            <Text style={s.label}>{providerPresets[id].label}</Text>
            {provider === id && <Ionicons name="checkmark" size={18} color={ui.accentInk} />}
          </Pressable>)}
          <Pressable disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: provider === "custom" }}
            style={s.option} onPress={() => selectProvider("custom")}>
            <Text style={s.label}>自定义（兼容接口）</Text>
          </Pressable>
        </View>}
        {provider === "custom" && urlInput}
        <View style={s.secret}>
          <BringField label="2. 粘贴 API Key" placeholder="请输入 API Key" editable={!busy} value={secret}
            onChangeText={value => { setSecret(value); setResult(undefined); }}
            secureTextEntry={!showKey} autoCapitalize="none" autoCorrect={false} autoComplete="off" style={s.secretField} />
          <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={showKey ? "隐藏密钥" : "显示密钥"}
            onPress={() => setShowKey(value => !value)} style={s.eye}>
            <Ionicons name={showKey ? "eye-off-outline" : "eye-outline"} size={20} color={ui.accentInk} />
          </Pressable>
        </View>
        <View style={s.modelRow}>
          <Text style={[s.body, s.model]} numberOfLines={2}>{preset && model === preset.model
            ? "推荐模型 · 已自动匹配" : model || "推荐模型 · 待选择"}</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: editModel }} disabled={busy || !provider}
            onPress={() => setEditModel(value => !value)} style={s.changeModel}>
            <Text style={s.link}>更换模型 ›</Text>
          </Pressable>
        </View>
        {editModel && <BringField label="模型名称" placeholder="请输入模型名称" editable={!busy} value={model}
          onChangeText={value => { setModel(value); setResult(undefined); }} autoCapitalize="none" autoCorrect={false} />}
      </> : <>
        <BringField label="家机名称" placeholder="请输入家机名称" editable={!busy} value={name}
          onChangeText={value => { setName(value); setResult(undefined); }} maxLength={200} />
        {urlInput}
        <Text style={s.body}>填写可直接接收聊天请求的完整地址，包含接口路径。</Text>
        <BringField label="访问密钥（Bearer Token）" placeholder="选填" editable={!busy} value={secret}
          onChangeText={value => { setSecret(value); setResult(undefined); }}
          secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" />
      </>}
    </GlassCard>
    {kind === "external" && <Text style={s.notice}>直连后由你自己的服务端驱动，不消耗平台对话额度</Text>}
    <Check checked={consent} disabled={busy} onPress={() => { setConsent(value => !value); setResult(undefined); }}
      label={kind === "key"
        ? "我同意将近期聊天、家机人设及记忆发给选定服务商。内容可能包含群聊中其他家机的消息，也可能用于日记生成。"
        : "我同意将近期聊天发给填写的外部接口，内容可能包含群聊中其他家机的消息及写日记用的聊天记录。"} />
    <Text style={s.body}>连通测试仅发送验证消息。启用后可在聊天设置里撤销连接。</Text>
    {result && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.notice}>{result}</Text>}
    <BringButton label={busy ? "正在测试…" : kind === "key" ? "测试并启用" : "测试并连通"} disabled={busy} onPress={() => void submit()} />
    <BringButton label={closeLabel} secondary disabled={busy} onPress={() => { if (!pending.current) onClose(); }} />
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
