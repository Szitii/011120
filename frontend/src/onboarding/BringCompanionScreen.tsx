import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, View,
} from "react-native";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import type { ClientApi, CompanionIdentity, ImportReview } from "../contracts";
import { useCommandKeys } from "../state/useCommandKeys";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { BringButton, BringField, Check, Choice, GlassCard, GlassIcon, createStyles } from "./BringControls";
import { importCardName, normalizeImportCard } from "./import-card";
import { ConnectionForm } from "./ConnectionForm";
import { extendedImportAvailability } from "./connection-client";

type Step = "entry" | "details" | "review" | "reply" | "key" | "external";
type Method = "card" | "manual";

const options = [
  { id: "card", icon: "document-text-outline", title: "导入人设与记忆",
    description: "上传角色卡、备份文档，或直接粘贴已有的人设与记忆",
    tags: "角色卡 · JSON · Markdown · 文本",
    help: "手里已有角色卡、本地备份文档，或想粘贴已有的人设与记忆迁移过来，无需运行独立后台。当前可导入 JSON 角色卡，Markdown 和纯文本记忆待开放。" },
  { id: "external", icon: "link-outline", title: "连接自建家机",
    description: "已有运行中的本体或外部 Agent，填入 HTTPS 接口地址",
    tags: "HTTPS 端点 · 独立驱动",
    help: "适合已搭建独立运行的家机或私有后台的人。人设、记忆和模型由你的服务管理。HTTPS 连接功能待开放。" },
  { id: "manual", icon: "person-add-outline", title: "从零创建",
    description: "还没有现成资料？写下名字和性格，记忆可以以后慢慢攒",
    tags: "新手推荐 · 30 秒完成",
    help: "第一次来、还没有现成资料，填写名字和性格就能开始。记忆可以在日常相处里慢慢积累。" },
] as const;

export function BringCompanionScreen({ api, existingCompanionId, onCreated, onBack }: {
  api: ClientApi;
  existingCompanionId?: string;
  onCreated: (identity: CompanionIdentity, approvedFields: string[]) => void;
  onBack: () => void;
}) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const [step, setStep] = useState<Step>("entry");
  const [method, setMethod] = useState<Method>("manual");
  const [help, setHelp] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [raw, setRaw] = useState("");
  const [file, setFile] = useState<{ name: string; size: number; text: string }>();
  const [missingName, setMissingName] = useState(false);
  const [importName, setImportName] = useState("");
  const [review, setReview] = useState<ImportReview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [selfKey, setSelfKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);
  const keys = useCommandKeys();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function back() {
    if (pending.current) return;
    setMessage("");
    switch (step) {
      case "entry": onBack(); break;
      case "details":
      case "external": setStep("entry"); break;
      case "review": setStep("details"); break;
      case "reply": setStep("review"); break;
      case "key": setStep("reply"); break;
    }
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => subscription.remove();
  }, [step, onBack]);

  const candidates = review?.draft?.candidates ?? [];
  const required = candidates.find(item => item.field === "displayName" && item.approvable);
  const labels: Record<string, string> = { displayName: "名字", identitySummary: "简介", personaTraits: "性格" };

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      if (mounted.current) {
        if (method === "card" && error instanceof ApiProblemError && error.code === "IMPORT_NAME_REQUIRED") {
          setMissingName(true);
        }
        setMessage(importMessage(error));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function inspect(value: string) {
    const normalized = value.replace(/^\uFEFF/, "").trim();
    let payload: unknown;
    try {
      payload = JSON.parse(normalized);
    } catch {
      setMessage(/^(?:\{|\[)/.test(normalized)
        ? "这份角色卡格式不完整。请重新选择文件或粘贴完整内容。"
        : extendedImportAvailability().message);
      return;
    }
    const card = normalizeImportCard(payload, method === "card" ? importName : "");
    if (!card) {
      setMessage("请选择包含一位家机资料的 JSON 文件。");
      return;
    }
    if (!importCardName(card)) {
      setMissingName(true);
      setMessage("请在上方补填家机名字，再核对资料。");
      return;
    }
    const result = await api.createCompanionImport(card, keys.forRequest("import", card));
    if (!mounted.current) return;
    keys.complete("import");
    setReview(result);
    setSelected((result.draft?.candidates ?? []).filter(item => item.approvable && item.field === "displayName").map(item => item.id));
    setSelfKey(false);
    setStep("review");
  }

  function pickFile() {
    Keyboard.dismiss();
    void run(async () => {
      const pick = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "text/plain", "text/markdown", "application/octet-stream"],
      });
      if (pick.canceled || !mounted.current) return;
      const item = pick.assets[0];
      const filename = item.name.toLowerCase();
      if (/\.(md|markdown|txt)$/.test(filename)) {
        setMessage(extendedImportAvailability().message);
        return;
      }
      if (!filename.endsWith(".json") || (item.size ?? 0) > 256 * 1024) {
        setMessage("请选择不超过 256 KB 的 .json 角色卡。");
        return;
      }
      const localFile = item.file ?? new File(item.uri);
      const size = item.size ?? localFile.size;
      if (size > 256 * 1024) {
        setMessage("请选择不超过 256 KB 的 .json 角色卡。");
        return;
      }
      const value = await localFile.text();
      if (!mounted.current) return;
      setFile({ name: item.name, size, text: value });
      setImportName("");
      setMissingName(false);
    });
  }

  function approve() {
    if (!review || !required) return;
    const ids = [...selected].sort();
    void run(async () => {
      const identity = await api.approveCompanionImport(review.id, ids, existingCompanionId,
        keys.forRequest("approve", [review.id, ids, existingCompanionId]));
      if (mounted.current) onCreated(identity, candidates.filter(item => ids.includes(item.id)).map(item => item.field));
    });
  }

  const heading = step === "entry" ? (existingCompanionId ? "更新家机资料" : "接入你的家机")
    : step === "details" ? (method === "manual" ? (existingCompanionId ? "填写家机资料" : "从零创建") : "导入人设与记忆")
    : step === "review" ? "核对家机资料"
    : step === "reply" ? "选择 TA 的回复方式"
    : step === "key" ? "自带 API Key" : "连接自建家机";
  const subtitle = {
    entry: existingCompanionId ? "选择这次更新资料的方式" : "选一种最适合你们的方式",
    details: method === "manual" ? "从名字和性格开始，记忆可以慢慢积累" : "先核对资料，再决定要带入哪些内容",
    review: "这些资料默认只留在你的小家",
    reply: "随时可在聊天设置里切换",
    key: "三步完成配置，随时可切回平台托管",
    external: "接入你自己的外部 Agent 或本体服务",
  }[step];

  return <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={s.bar}>
      <GlassIcon label="返回" icon="chevron-back" onPress={back} disabled={busy} />
      {step === "entry" && <GlassIcon label="接入方式帮助" icon="information-circle-outline" onPress={() => setHelp(true)} />}
    </View>
    <ScrollView key={step} style={s.flex} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}>
      {step !== "entry" && step !== "external" && !existingCompanionId && <View style={s.progress} accessible
        accessibilityLabel={step === "details" || step === "review" ? "第 1 步，共 2 步" : "第 2 步，共 2 步"}>
        <View style={[s.segment, s.segmentCurrent]} />
        <View style={[s.segment, (step === "reply" || step === "key") && s.segmentCurrent]} />
      </View>}
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={s.heading}>
        <Text accessibilityRole="header" style={s.title}>{heading}</Text>
        <Text style={s.body}>{subtitle}</Text>
      </Pressable>

      {step === "entry" && options.filter(option => !existingCompanionId || option.id !== "external").map(option => (
        <Choice key={option.id} icon={option.icon} title={existingCompanionId && option.id === "manual" ? "手动填写" : option.title}
          description={option.description} note={option.tags} onPress={() => {
            setMessage("");
            if (option.id === "external") setStep("external");
            else { setMethod(option.id); setStep("details"); }
          }} />
      ))}

      {step === "details" && <GlassCard>
        {method === "manual" ? <>
          <BringField label="名字" placeholder="怎么称呼 TA？" value={name} onChangeText={setName} editable={!busy} maxLength={200} />
          <BringField label="简介（选填）" value={description} onChangeText={setDescription} editable={!busy} multiline />
          <BringField label="性格（选填）" value={personality} onChangeText={setPersonality} editable={!busy} multiline />
          <BringButton label="预览资料" disabled={busy || !name.trim()}
            onPress={() => void run(() => inspect(JSON.stringify({ name: name.trim(), description, personality })))} />
        </> : <>
          <BringButton label="选择角色卡文件" secondary disabled={busy} onPress={pickFile} />
          <Text style={s.body}>目前支持 JSON 角色卡。私密记忆库不会导入。请先移除密码、密钥和私人聊天记录。</Text>
          {missingName && <BringField label="家机名字" placeholder="请补填家机名字" value={importName}
            onChangeText={setImportName} editable={!busy} maxLength={200} />}
          {file ? <View style={s.fileRow}>
            <View style={s.flex}>
              <Text numberOfLines={1} style={s.label}>{file.name}</Text>
              <Text style={s.note}>{file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</Text>
            </View>
            <GlassIcon icon="close" label="清除已选文件" disabled={busy} onPress={() => {
              setFile(undefined);
              setImportName("");
              setMissingName(false);
              setMessage("");
            }} />
          </View> : <BringField label="粘贴角色卡" placeholder="粘贴角色卡内容" value={raw}
            onChangeText={value => { setRaw(value); setMessage(""); }}
            editable={!busy} multiline scrollEnabled style={s.pasteInput} autoCapitalize="none" autoCorrect={false} />}
          <BringButton label="核对角色卡" disabled={busy || !(file?.text ?? raw).trim()}
            onPress={() => { Keyboard.dismiss(); void run(() => inspect(file?.text ?? raw)); }} />
        </>}
      </GlassCard>}

      {step === "review" && <>
        {candidates.map(item => <GlassCard key={item.id}>
          <Text style={s.label}>{labels[item.field] ?? "资料"}</Text>
          <Text style={s.body}>{item.approvable
            ? (Array.isArray(item.value) ? item.value.join("、") : String(item.value))
            : "该项未通过检查，无法带入。"}</Text>
          {item.approvable && item.id !== required?.id && <Check label="保留这项" checked={selected.includes(item.id)}
            onPress={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}
            disabled={busy} />}
        </GlassCard>)}
        {review && review.findings.length > 0 && <Text style={s.body}>有 {review.findings.length} 项检查提示。敏感内容和额外资料不会带入。</Text>}
        {!required && <Text accessibilityRole="alert" style={s.body}>请返回修改名字，再提交核对。</Text>}
        <BringButton label={existingCompanionId ? "确认更新" : "下一步"} disabled={busy || !required}
          onPress={existingCompanionId ? approve : () => setStep("reply")} />
      </>}

      {step === "reply" && <>
        <View accessibilityRole="radiogroup" style={s.replyOptions}>
          <Choice icon="cloud-outline" title="平台托管" badge="默认" selected={!selfKey}
            description="使用平台模型回复，无需自己配置"
            note="新手体验额度与余额功能待开放，当前以平台可用额度为准"
            onPress={() => { if (!pending.current) setSelfKey(false); }} />
          <Choice icon="key-outline" title="自带 API Key" selected={selfKey}
            description="填写你自己的服务商密钥，使用个人账号额度"
            note="支持常用服务商 · 服务端接入待开放"
            onPress={() => { if (!pending.current) setSelfKey(true); }} />
        </View>
        <BringButton label={selfKey ? "继续配置" : "完成入驻"} disabled={busy || !required}
          onPress={selfKey ? () => { setMessage(""); setStep("key"); } : approve} />
      </>}

      {(step === "key" || step === "external") && <ConnectionForm kind={step}
        onPlatform={() => { setSelfKey(false); setStep(step === "key" ? "reply" : "entry"); }} />}

      {busy && <ActivityIndicator color={ui.accent} accessibilityLabel="正在处理家机资料" />}
      {message !== "" && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.alert}>{message}</Text>}
      {step === "entry" && !existingCompanionId && <Text style={s.hint}>随时可以在设置中调整连接方式</Text>}
    </ScrollView>

    <Modal visible={help} transparent animationType="fade" onRequestClose={() => setHelp(false)}>
      <View style={s.modal}>
        <Pressable accessibilityLabel="关闭帮助" style={StyleSheet.absoluteFill} onPress={() => setHelp(false)} />
        <LiquidGlassSurface glass borderRadius={30} style={s.sheet}>
          <View style={s.sheetTitle}>
            <Text accessibilityRole="header" style={s.sheetHeading}>我该选哪一种？</Text>
            <GlassIcon label="关闭" icon="close" onPress={() => setHelp(false)} />
          </View>
          <ScrollView contentContainerStyle={s.helpContent}>
            {options.filter(option => !existingCompanionId || option.id !== "external").map(option => (
              <View key={option.id} style={s.helpItem}>
                <Text style={s.label}>{option.title}</Text>
                <Text style={s.body}>{option.help}</Text>
              </View>
            ))}
          </ScrollView>
          <BringButton label="我知道了" onPress={() => setHelp(false)} />
        </LiquidGlassSurface>
      </View>
    </Modal>
  </KeyboardAvoidingView>;
}

function importMessage(error: unknown): string {
  if (error instanceof ApiProblemError) {
    if (error.code === "IMPORT_NAME_REQUIRED") return "请先给家机填一个名字。";
    if (error.status === 413) return "角色卡超过 256 KB，请删减后再试。";
    if (error.status === 415 || error.status === 400) return "这份资料无法读取，请检查名字与角色卡格式。";
    if (error.status === 404) return "这次审核已不可用，请返回重新核对资料。";
    if (error.status === 409) return "审核状态已经变化，请返回重新核对资料。";
  }
  return safeClientMessage(error).title;
}
