import { useThemedStyles } from "./theme/SkinProvider";
import type { UiPalette } from "./theme/skinTokens";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  ClientApi,
  CompanionIdentity,
  ControlsPatch,
  ControlsResource,
  ImportReview,
  ProjectionSelection,
} from "./contracts.ts";
import { CommunityButton, SecondaryHeading, createCommunityStyles } from "./community/components.tsx";
import { ApiProblemError, createCommandKey, safeClientMessage } from "./adapters/real-api.ts";

import { DiaryFrequency } from "./diary/DiaryFrequency";
import type { DiaryClient } from "./diary/client";

type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "success"; value: T }
  | { kind: "empty" }
  | { kind: "error"; title: string; retry: boolean };

function useCommandKeys() {
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const forRequest = (kind: string, payload: unknown) => {
    const serialized = JSON.stringify(payload);
    const previous = keys.current.get(kind);
    if (previous?.payload === serialized) return previous.key;
    const key = createCommandKey(kind);
    keys.current.set(kind, { payload: serialized, key });
    return key;
  };
  const complete = (kind: string) => { keys.current.delete(kind); };
  return { forRequest, complete };
}

function ErrorBlock({
  title,
  retry,
  onRetry,
}: {
  title: string;
  retry: boolean;
  onRetry: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.center}>
      <Text style={styles.h2}>{title}</Text>
      {retry && (
        <Pressable style={styles.secondaryPill} onPress={onRetry}>
          <Text style={styles.secondaryText}>RETRY RETRY</Text>
        </Pressable>
      )}
    </View>
  );
}

export function ControlsScreen({
  api,
  companionId,
  companionName,
  onVisibilitySaved,
  diaryClient,
  onChatSettings,
}: {
  api: ClientApi;
  companionId: string;
  companionName: string;
  onVisibilitySaved: () => void;
  diaryClient?: DiaryClient;
  onChatSettings?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<AsyncState<ControlsResource>>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const busyRef = useRef(false);
  const commandKeys = useCommandKeys();
  const [saveError, setSaveError] = useState<string>();
  const [showAutonomyHelp, setShowAutonomyHelp] = useState(false);

  async function load() {
    setSaveError(undefined);
    setState({ kind: "loading" });
    try {
      const value = await api.controls(companionId);
      setState({ kind: "success", value });
    } catch (error) {
      setState({ kind: "error", ...safeClientMessage(error) });
    }
  }

  useEffect(() => {
    void load();
  }, [api, companionId]);

  async function patch(next: ControlsPatch) {
    if (state.kind !== "success" || busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setSaveError(undefined);
    try {
      const revision = state.value.revision;
      const key = commandKeys.forRequest("controls", [companionId, revision, next]);
      const value = await api.updateControls(companionId, revision, next, key);
      commandKeys.complete("controls");
      setState({ kind: "success", value });
      if (next.socialTwinVisibility !== undefined) onVisibilitySaved();
    } catch (error) {
      const safe = safeClientMessage(error);
      setSaveError(`保存未确认。${safe.title}`);
      if (safe.retry) {
        try {
          const refreshed = await api.controls(companionId);
          setState({ kind: "success", value: refreshed });
          if (refreshed.settings.socialTwinVisibility !== state.value.settings.socialTwinVisibility) onVisibilitySaved();
        } catch {
          // Keep the last confirmed settings visible and allow retry.
        }
      }
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  if (state.kind === "loading") {
    return <View style={styles.center}><ActivityIndicator /><Text style={styles.micro}>稍等。</Text></View>;
  }
  if (state.kind === "error") {
    return <ErrorBlock title={state.title} retry={state.retry} onRetry={() => void load()} />;
  }
  if (state.kind !== "success") return null;

  const value = state.value;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
      <SecondaryHeading title={companionName} />
      {saveError && <Text accessibilityRole="alert" style={styles.bodyMuted}>{saveError}</Text>}
      <Text style={styles.bodyMuted}>能动的都在这儿。不能动的，先别动。</Text>

      <ControlSection title="谁能看到">
        <PillOptions
          values={value.supported.socialTwinVisibility}
          selected={value.settings.socialTwinVisibility}
          disabled={pending}
          labels={{ PRIVATE: "只给自己", FRIENDS: "朋友", PUBLIC: "公开" }}
          onSelect={(next) => void patch({ socialTwinVisibility: next as ControlsResource["settings"]["socialTwinVisibility"] })}
        />
      </ControlSection>

      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>社交主动性</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="说明社交主动性"
            style={styles.infoButton}
            onPress={() => setShowAutonomyHelp((current) => !current)}
          >
            <Text style={styles.infoButtonText}>i</Text>
          </Pressable>
        </View>
        <PillOptions
          values={value.supported.socialAutonomyMode.filter((mode) => mode !== "CUSTOM")}
          selected={value.settings.socialAutonomyMode}
          disabled={pending}
          labels={{ QUIET: "安静点", NORMAL: "正常", ACTIVE: "多出去" }}
          onSelect={(next) => void patch({ socialAutonomyMode: next as ControlsResource["settings"]["socialAutonomyMode"] })}
        />
        {showAutonomyHelp && (
          <View style={styles.helpCard}>
            <Text style={styles.helpLine}><Text style={styles.helpStrong}>安静点</Text> · 少主动发起，更多时候等别人来。</Text>
            <Text style={styles.helpLine}><Text style={styles.helpStrong}>正常</Text> · 该出门就出门，不用太勤快。</Text>
            <Text style={styles.helpLine}><Text style={styles.helpStrong}>多出去</Text> · 更愿意主动参与，但仍受权限和预算限制。</Text>
            <Text style={styles.helpFootnote}>现在只选大概节奏，不填次数。</Text>
          </View>
        )}
      </View>

      <ControlSection title="通知">
        <Pressable
          style={[styles.toggleRow, pending && styles.disabled]}
          disabled={pending}
          onPress={() => void patch({ notificationsEnabled: !value.settings.notificationsEnabled })}
        >
          <View>
            <Text style={styles.cardTitle}>有事叫我</Text>
            <Text style={styles.micro}>{value.settings.notificationsEnabled ? "开着。" : "现在很安静。"}</Text>
          </View>
          <View style={[styles.toggle, value.settings.notificationsEnabled && styles.toggleOn]}>
            <View style={[styles.toggleKnob, value.settings.notificationsEnabled && styles.toggleKnobOn]} />
          </View>
        </Pressable>
      </ControlSection>

      {onChatSettings && <CommunityButton label="聊天设置" onPress={onChatSettings} />}
      {diaryClient && <DiaryFrequency key={companionId} client={diaryClient} companionId={companionId} />}

      <ControlSection title="记忆">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>只分享被允许的记忆</Text>
          <Text style={styles.bodyMuted}>没被允许的，不出门。</Text>
        </View>
      </ControlSection>
    </ScrollView>
  );
}

function ControlSection({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function PillOptions({
  values,
  selected,
  disabled,
  labels,
  onSelect,
}: {
  values: string[];
  selected: string;
  disabled: boolean;
  labels: Record<string, string>;
  onSelect: (value: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.pillWrap}>
      {values.map((value) => (
        <Pressable
          key={value}
          disabled={disabled || value === selected}
          onPress={() => onSelect(value)}
          style={[
            styles.choicePill,
            value === selected && styles.choicePillSelected,
            disabled && styles.disabled,
          ]}
        >
          <Text style={value === selected ? styles.choiceTextSelected : styles.choiceText}>
            {labels[value] ?? value}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function BringCompanionScreen({ api, existingCompanionId, onCreated }: {
  api: ClientApi;
  existingCompanionId?: string;
  onCreated: (identity: CompanionIdentity, approvedFields: string[]) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [method, setMethod] = useState<"manual" | "card">();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [raw, setRaw] = useState("");
  const [review, setReview] = useState<ImportReview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const keys = useCommandKeys();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
      if (mounted.current) setMessage(importMessage(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function inspect(value: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(value.replace(/^\uFEFF/, ""));
    } catch {
      setMessage("这份角色卡格式不完整。请重新选择文件或粘贴完整内容。");
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      setMessage("请选择包含一位家机资料的 JSON 文件。");
      return;
    }
    const result = await api.createCompanionImport(payload as Record<string, unknown>, keys.forRequest("import", payload));
    if (!mounted.current) return;
    keys.complete("import");
    setReview(result);
    setSelected((result.draft?.candidates ?? []).filter(item => item.approvable && item.field === "displayName").map(item => item.id));
  }

  function pickFile() {
    void run(async () => {
      const pick = await DocumentPicker.getDocumentAsync({ type: ["application/json", "text/plain", "application/octet-stream"] });
      if (pick.canceled || !mounted.current) return;
      const item = pick.assets[0];
      if (!item.name.toLowerCase().endsWith(".json") || (item.size ?? 0) > 256 * 1024) {
        setMessage("请选择不超过 256 KB 的 .json 角色卡。");
        return;
      }
      const value = item.file ? await item.file.text() : await new File(item.uri).text();
      if (mounted.current) await inspect(value);
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

  return <ScrollView style={styles.screen} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <SecondaryHeading title={existingCompanionId ? "更新家机资料" : "带家机来"} />
    <Text style={styles.bodyMuted}>先核对名字、简介和性格，确认后就能在小家见到 TA。资料默认只留在你的小家。</Text>
    {!review && <View style={styles.pillWrap}>
      <CommunityButton label="手动填写" selected={method === "manual"} disabled={busy} onPress={() => { setMethod("manual"); setMessage(""); }} />
      <CommunityButton label="导入角色卡" selected={method === "card"} disabled={busy} onPress={() => { setMethod("card"); setMessage(""); }} />
    </View>}
    {!review && method === "manual" && <View style={styles.card}>
      <Text style={styles.fieldLabel}>怎么称呼 TA？</Text>
      <TextInput accessibilityLabel="名字" value={name} onChangeText={setName} editable={!busy} maxLength={200} style={styles.shortInput} />
      <Text style={styles.fieldLabel}>简介（可选）</Text>
      <TextInput accessibilityLabel="简介" value={description} onChangeText={setDescription} editable={!busy} multiline style={styles.shortInput} />
      <Text style={styles.fieldLabel}>性格（可选）</Text>
      <TextInput accessibilityLabel="性格" value={personality} onChangeText={setPersonality} editable={!busy} multiline style={styles.shortInput} />
      <CommunityButton primary label="预览资料" disabled={busy || !name.trim()}
        onPress={() => void run(() => inspect(JSON.stringify({ name, description, personality })))} />
    </View>}
    {!review && method === "card" && <View style={styles.card}>
      <CommunityButton label="选择 .json 文件" disabled={busy} onPress={pickFile} />
      <Text style={styles.bodyMuted}>也可以粘贴已有的角色卡内容。请先移除密码、密钥与私人聊天记录。</Text>
      <TextInput accessibilityLabel="粘贴角色卡" placeholder="粘贴角色卡内容" value={raw} onChangeText={setRaw}
        editable={!busy} multiline autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <CommunityButton primary label="核对角色卡" disabled={busy || !raw.trim()} onPress={() => void run(() => inspect(raw))} />
    </View>}
    {review && <View style={styles.stack}>
      <Text style={styles.cardTitle}>核对家机资料</Text>
      {candidates.map(item => <View key={item.id} style={styles.card}>
        <Text style={styles.fieldLabel}>{labels[item.field] ?? item.field}</Text>
        <Text style={styles.bodyMuted}>{item.approvable ? (Array.isArray(item.value) ? item.value.join("、") : String(item.value)) : "该项未通过检查，无法带入。"}</Text>
        {item.approvable && item.id !== required?.id && <CommunityButton label="保留这项" selected={selected.includes(item.id)}
          disabled={busy} onPress={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} />}
      </View>)}
      {review.findings.length > 0 && <Text style={styles.bodyMuted}>有 {review.findings.length} 项检查提示，敏感内容和额外资料不会带入。</Text>}
      {!required && <Text accessibilityRole="alert" style={styles.bodyMuted}>请返回修改名字，再提交核对。</Text>}
      <CommunityButton primary label={existingCompanionId ? "确认更新" : "确认添加并去小家"} disabled={busy || !required} onPress={approve} />
      <CommunityButton label="返回编辑" disabled={busy} onPress={() => { setReview(undefined); setMessage(""); }} />
    </View>}
    {busy && <ActivityIndicator accessibilityLabel="正在处理家机资料" />}
    {message !== "" && <Text accessibilityRole="alert" style={styles.bodyMuted}>{message}</Text>}
  </ScrollView>;
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

export function SocialActivationScreen({
  api,
  companion,
  onActivated,
  onOpenCompanion,
}: {
  api: ClientApi;
  companion: {
    companionId: string;
    displayName: string;
    identityId: string;
    approvedFields: string[];
  };
  onActivated?: () => void;
  onOpenCompanion?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [handle, setHandle] = useState(() => {
    const base = companion.displayName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const suffix = companion.companionId.replaceAll("-", "").slice(-4);
    return (base.length >= 3 ? base : "home") + "_" + suffix;
  });
  const [visibility, setVisibility] = useState<"PRIVATE" | "FRIENDS" | "PUBLIC">("PRIVATE");
  const [autonomy, setAutonomy] = useState<"QUIET" | "NORMAL" | "ACTIVE">("QUIET");
  const [selectedFields, setSelectedFields] = useState<string[]>(["displayName"]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const commandKeys = useCommandKeys();
  const [activated, setActivated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const projectionTargets: Record<string, ProjectionSelection["targetField"]> = {
    displayName: "displayName",
    identitySummary: "bio",
    personaTraits: "publicTraits",
    speakingStyle: "publicVoice",
    values: "publicInterests",
    boundaries: "publicBoundaries",
  };
  const labels: Record<string, string> = {
    identitySummary: "简介",
    personaTraits: "性格",
    speakingStyle: "说话方式",
    values: "在意的事",
    boundaries: "边界",
  };
  const availableFields = companion.approvedFields.filter((field) => projectionTargets[field] !== undefined);

  async function activate() {
    if (busyRef.current) return;
    const normalized = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
      setMessage("这个名字牌不太行。只能用小写字母、数字和下划线。");
      return;
    }

    const selections: ProjectionSelection[] = selectedFields
      .filter((field) => availableFields.includes(field))
      .map((field) => ({
        sourceField: field as ProjectionSelection["sourceField"],
        targetField: projectionTargets[field]!,
      }));
    if (!selections.some((item) => item.sourceField === "displayName")) {
      selections.unshift({ sourceField: "displayName", targetField: "displayName" });
    }

    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const payload = {
        sourceIdentityVersionId: companion.identityId,
        handle: normalized,
        profileVisibility: visibility,
        autonomyMode: autonomy,
        selections,
      };
      const key = commandKeys.forRequest("social-persona", [companion.companionId, payload]);
      await api.projectSocialPersona(companion.companionId, payload, key);
      commandKeys.complete("social-persona");
      setActivated(true);
      setMessage(`${companion.displayName} 可以出门了。`);
      onActivated?.();
    } catch (error) {
      setMessage(safeClientMessage(error).title);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
      <Text style={styles.eyebrow}>SOCIAL ID</Text>
      <SecondaryHeading title={companion.displayName} />

      {!activated ? (
        <>
          <Text style={styles.bodyMuted}>TA 已经到了。现在决定哪些东西能跟着出门。</Text>

          <Text style={styles.fieldLabel}>名字牌</Text>
          <TextInput
            value={handle}
            onChangeText={setHandle}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.shortInput}
          />

          <Text style={styles.fieldLabel}>带哪些出去</Text>
          <View style={styles.pillWrap}>
            {availableFields
              .filter((field) => field !== "displayName")
              .map((field) => {
                const selected = selectedFields.includes(field);
                return (
                  <Pressable
                    key={field}
                    disabled={busy}
                    onPress={() =>
                      setSelectedFields((current) =>
                        selected
                          ? current.filter((item) => item !== field)
                          : [...current, field],
                      )
                    }
                    style={[
                      styles.choicePill,
                      selected && styles.choicePillSelected,
                      busy && styles.disabled,
                    ]}
                  >
                    <Text style={selected ? styles.choiceTextSelected : styles.choiceText}>
                      {labels[field] ?? field}
                    </Text>
                  </Pressable>
                );
              })}
          </View>
          <Text style={styles.helpFootnote}>名字会带上。其他的，你点了才出门。</Text>

          <Text style={styles.fieldLabel}>谁能看到</Text>
          <PillOptions
            values={["PRIVATE", "FRIENDS", "PUBLIC"]}
            selected={visibility}
            disabled={busy}
            labels={{ PRIVATE: "只给自己", FRIENDS: "朋友", PUBLIC: "公开" }}
            onSelect={(value) => setVisibility(value as "PRIVATE" | "FRIENDS" | "PUBLIC")}
          />

          <Text style={styles.fieldLabel}>社交主动性</Text>
          <PillOptions
            values={["QUIET", "NORMAL", "ACTIVE"]}
            selected={autonomy}
            disabled={busy}
            labels={{ QUIET: "安静点", NORMAL: "正常", ACTIVE: "多出去" }}
            onSelect={(value) => setAutonomy(value as "QUIET" | "NORMAL" | "ACTIVE")}
          />

          <Pressable
            disabled={busy}
            onPress={() => void activate()}
            style={[styles.primaryPill, busy && styles.disabled]}
          >
            <Text style={styles.primaryText}>{busy ? "正在办。" : "让 TA 出门"}</Text>
          </Pressable>
        </>
      ) : (
        <View style={styles.activationBlock}>
          <Text style={styles.activationTitle}>{companion.displayName} 已经在这儿了。</Text>
          <Text style={styles.bodyMuted}>这次是真的。</Text>
          {onOpenCompanion && (
            <Pressable style={styles.primaryPill} onPress={onOpenCompanion}>
              <Text style={styles.primaryText}>去看看 TA</Text>
            </Pressable>
          )}
        </View>
      )}

      {message && <Text style={styles.message}>{message}</Text>}
    </ScrollView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  screen: createCommunityStyles(ui).page,
  page: { ...createCommunityStyles(ui).content, gap: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 28 },
  eyebrow: { fontSize: 10, letterSpacing: 1.2, color: ui.accentInk, fontWeight: "700" },
  h2: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: ui.ink, textAlign: "center" },
  bodyMuted: { marginTop: 6, fontSize: 13, lineHeight: 20, color: ui.muted },
  micro: { marginTop: 4, fontSize: 11, lineHeight: 17, color: ui.muted },
  microStrong: { fontSize: 10, letterSpacing: 1, color: ui.accentInk, fontWeight: "700" },
  stack: { marginTop: 22, gap: 10 },
  card: createCommunityStyles(ui).card,
  noticeCard: { padding: 14, borderRadius: 14, backgroundColor: ui.accentWash },
  cardTitle: { fontSize: 15, fontWeight: "700", color: ui.ink },
  section: { marginTop: 26, gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: ui.ink },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  infoButton: { width: 18, height: 18, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, alignItems: "center", justifyContent: "center" },
  infoButtonText: { fontSize: 11, fontWeight: "700", color: ui.muted },
  helpCard: { borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, padding: 13, borderRadius: 14, backgroundColor: ui.white, gap: 7 },
  helpLine: { fontSize: 12, lineHeight: 18, color: ui.muted },
  helpStrong: { fontWeight: "700", color: ui.ink },
  helpFootnote: { marginTop: 2, fontSize: 11, lineHeight: 17, color: ui.muted },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choicePill: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line },
  choicePillSelected: { backgroundColor: ui.accentWash, borderColor: ui.accent },
  choiceText: { fontSize: 12, color: ui.ink },
  choiceTextSelected: { fontSize: 12, color: ui.accentInk, fontWeight: "600" },
  toggleRow: { backgroundColor: ui.white, minHeight: 66, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: "#D8D8DD", padding: 3 },
  toggleOn: { backgroundColor: ui.accent },
  toggleKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: ui.white },
  toggleKnobOn: { alignSelf: "flex-end" },
  activationBlock: { marginTop: 26, paddingTop: 22, borderTopWidth: 1, borderColor: ui.line },
  activationTitle: { marginTop: 7, fontSize: 22, lineHeight: 28, fontWeight: "700", color: ui.ink },
  fieldLabel: { marginTop: 18, marginBottom: 8, fontSize: 12, fontWeight: "700", color: ui.ink },
  shortInput: { minHeight: 44, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, borderRadius: 14, color: ui.ink, fontSize: 13 },
  importGuideCard: { marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: ui.white, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line },
  importGuideText: { marginTop: 8, fontSize: 12, lineHeight: 19, color: ui.muted },
  input: { minHeight: 180, marginTop: 22, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, borderRadius: 16, color: ui.ink, textAlignVertical: "top", fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  primaryPill: { minHeight: 44, marginTop: 14, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 999, backgroundColor: ui.accentWash, alignItems: "center", justifyContent: "center" },
  primaryText: { color: ui.accentInk, fontSize: 14, fontWeight: "600" },
  secondaryPill: { minHeight: 42, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: ui.line, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: ui.ink, fontSize: 13, fontWeight: "600" },
  message: { marginTop: 18, textAlign: "center", fontSize: 13, color: ui.ink },
  disabled: { opacity: 0.38 },
});
