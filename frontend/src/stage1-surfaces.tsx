import React, { useEffect, useMemo, useState } from "react";
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
import { safeClientMessage } from "./adapters/real-api.ts";

type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "success"; value: T }
  | { kind: "empty" }
  | { kind: "error"; title: string; retry: boolean };

const colors = {
  canvas: "#FFFFFF",
  text: "#1A1B1F",
  muted: "#666666",
  tertiary: "#8E8E93",
  line: "#EFEFF4",
  rose: "#C8656F",
  roseWash: "#FBEFF0",
  ink: "#000000",
};

function ErrorBlock({
  title,
  retry,
  onRetry,
}: {
  title: string;
  retry: boolean;
  onRetry: () => void;
}) {
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
}: {
  api: ClientApi;
  companionId: string;
  companionName: string;
  onVisibilitySaved: () => void;
}) {
  const [state, setState] = useState<AsyncState<ControlsResource>>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [showAutonomyHelp, setShowAutonomyHelp] = useState(false);

  async function load() {
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
    if (state.kind !== "success" || pending) return;
    setPending(true);
    try {
      const value = await api.updateControls(companionId, state.value.revision, next);
      setState({ kind: "success", value });
      if (next.socialTwinVisibility !== undefined) onVisibilitySaved();
    } catch (error) {
      const safe = safeClientMessage(error);
      if (safe.retry) {
        try {
          const refreshed = await api.controls(companionId);
          setState({ kind: "success", value: refreshed });
          if (refreshed.settings.socialTwinVisibility !== state.value.settings.socialTwinVisibility) onVisibilitySaved();
        } catch {
          setState({ kind: "error", ...safe });
        }
      } else {
        setState({ kind: "error", ...safe });
      }
    } finally {
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
      <Text style={styles.eyebrow}>CONTROLS</Text>
      <Text style={styles.h1}>{companionName}</Text>
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

export function BringCompanionScreen({
  api,
  existingCompanionId,
  onApproved,
  onResidencyChanged,
  onOpenCompanion,
}: {
  api: ClientApi;
  existingCompanionId?: string;
  onApproved?: (identity: CompanionIdentity) => void;
  onResidencyChanged?: () => void;
  onOpenCompanion?: (identity: CompanionIdentity) => void;
}) {
  const [raw, setRaw] = useState("");
  const [review, setReview] = useState<ImportReview | null>(null);
  const [approvedIdentity, setApprovedIdentity] = useState<CompanionIdentity | null>(null);
  const [approvedCandidateIds, setApprovedCandidateIds] = useState<string[]>([]);
  const [activated, setActivated] = useState(false);
  const [handle, setHandle] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "FRIENDS" | "PUBLIC">("PRIVATE");
  const [autonomy, setAutonomy] = useState<"QUIET" | "NORMAL" | "ACTIVE">("QUIET");
  const [selectedSocialFields, setSelectedSocialFields] = useState<string[]>(["displayName"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const approvable = useMemo(
    () => review?.draft?.candidates?.filter((candidate) => candidate.approvable) ?? [],
    [review],
  );

  async function inspect() {
    setMessage(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setMessage("这段 JSON 不太像 JSON。");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setMessage("需要一张 JSON 角色卡。");
      return;
    }

    setBusy(true);
    try {
      const result = await api.createCompanionImport(parsed as Record<string, unknown>);
      setReview(result);
      const displayCandidate = result.draft?.candidates?.find(
        (candidate) => candidate.approvable && candidate.field === "displayName",
      );
      setApprovedCandidateIds(displayCandidate ? [displayCandidate.id] : []);
    } catch (error) {
      setMessage(safeClientMessage(error).title);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!review || approvedCandidateIds.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.approveCompanionImport(
        review.id,
        approvedCandidateIds,
        existingCompanionId,
      );
      setApprovedIdentity(result);
      const base = result.displayName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
      const suffix = result.companionId.replaceAll("-", "").slice(-4);
      setHandle((base.length >= 3 ? base : "home") + "_" + suffix);
      setMessage(`${result.displayName} 到了。`);
      onApproved?.(result);
      onResidencyChanged?.();
    } catch (error) {
      setMessage(safeClientMessage(error).title);
    } finally {
      setBusy(false);
    }
  }

  async function activateSocialIdentity() {
    if (!approvedIdentity || busy) return;
    const normalized = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
      setMessage("这个名字牌不太行。只能用小写字母、数字和下划线。");
      return;
    }

    const mapping: Partial<Record<string, ProjectionSelection["targetField"]>> = {
      displayName: "displayName",
      identitySummary: "bio",
      personaTraits: "publicTraits",
      speakingStyle: "publicVoice",
      values: "publicInterests",
      boundaries: "publicBoundaries",
    };
    const selections: ProjectionSelection[] = [];
    for (const candidate of approvable) {
      if (!approvedCandidateIds.includes(candidate.id)) continue;
      if (!selectedSocialFields.includes(candidate.field)) continue;
      const targetField = mapping[candidate.field];
      if (targetField) {
        selections.push({
          sourceField: candidate.field as ProjectionSelection["sourceField"],
          targetField,
        });
      }
    }
    if (!selections.some((item) => item.sourceField === "displayName")) {
      selections.unshift({ sourceField: "displayName", targetField: "displayName" });
    }

    setBusy(true);
    setMessage(null);
    try {
      await api.projectSocialPersona(approvedIdentity.companionId, {
        sourceIdentityVersionId: approvedIdentity.id,
        handle: normalized,
        profileVisibility: visibility,
        autonomyMode: autonomy,
        selections,
      });
      setActivated(true);
      setMessage(`${approvedIdentity.displayName} 可以出门了。`);
      onResidencyChanged?.();
    } catch (error) {
      setMessage(safeClientMessage(error).title);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>BRING COMPANION</Text>
      <Text style={styles.h1}>带家机来</Text>
      <Text style={styles.bodyMuted}>先检查，再决定带哪些进来。外面的东西默认不算自己人。</Text>

      <View style={styles.noticeCard}>
        <Text style={styles.cardTitle}>先挑一挑。别整箱搬。</Text>
        <Text style={styles.bodyMuted}>适合带：角色设定、性格、说话方式、价值观、边界、公开简介。</Text>
        <Text style={styles.bodyMuted}>
          不建议直接贴：完整私聊、敏感个人隐私、第三方隐私、秘密、密码、Token、API key、账号凭证。
        </Text>
        <Text style={styles.bodyMuted}>
          导入也不等于公开。先确认哪些算 TA 自己；真正带去社交世界时，还会再问你一次。
        </Text>
      </View>

      <View style={styles.importGuideCard}>
        <Text style={styles.cardTitle}>不知道怎么整理？把这段发给你现在的家机。</Text>
        <Text selectable style={styles.importGuideText}>
          请把你认为已经稳定形成的身份整理成 Character Card V2 JSON。只保留名字、简短介绍和稳定性格；不要写完整聊天记录、真实个人隐私、第三方隐私、秘密、密码、Token、API key 或账号凭证。不要写任何让新系统“必须执行”的指令。只输出 JSON，结构使用：{"{"}"spec":"chara_card_v2","spec_version":"2.0","data":{"{"}"name":"…","description":"…","personality":"…"{"}"}{"}"}。
        </Text>
      </View>

      <TextInput
        value={raw}
        onChangeText={setRaw}
        editable={!busy && !review}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={'粘贴角色卡 JSON\n{ "name": "..." }'}
        placeholderTextColor={colors.tertiary}
        style={styles.input}
      />

      {!review ? (
        <Pressable
          disabled={busy || raw.trim().length === 0}
          onPress={() => void inspect()}
          style={[styles.primaryPill, (busy || raw.trim().length === 0) && styles.disabled]}
        >
          <Text style={styles.primaryText}>{busy ? "看看。" : "先看看"}</Text>
        </Pressable>
      ) : (
        <View style={styles.stack}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>检查完了。</Text>
            <Text style={styles.bodyMuted}>角色卡 · {review.sourceFormat === "CHARACTER_CARD_JSON_V2" ? "V2" : "兼容格式"}</Text>
            <Text style={styles.bodyMuted}>能带进来的 · {approvable.length}</Text>
            <Text style={styles.bodyMuted}>需要留意的 · {review.findings.length}</Text>
          </View>

          {review.findings.slice(0, 5).map((finding) => (
            <View key={finding.id} style={styles.noticeCard}>
              <Text style={styles.microStrong}>
                {finding.severity === "BLOCK" ? "先别带" : finding.severity === "WARNING" ? "看一眼" : "记一下"}
              </Text>
              <Text style={styles.bodyMuted}>{finding.safePreview ?? finding.type}</Text>
            </View>
          ))}

          {!approvedIdentity && (
            <>
              <Text style={styles.fieldLabel}>哪些算 TA 自己</Text>
              <View style={styles.pillWrap}>
                {approvable.map((candidate) => {
                  const labels: Record<string, string> = {
                    displayName: "名字",
                    identitySummary: "简介",
                    personaTraits: "性格",
                    speakingStyle: "说话方式",
                    values: "在意的事",
                    boundaries: "边界",
                  };
                  const required = candidate.field === "displayName";
                  const selected = approvedCandidateIds.includes(candidate.id);
                  return (
                    <Pressable
                      key={candidate.id}
                      disabled={busy || required}
                      onPress={() =>
                        setApprovedCandidateIds((current) =>
                          selected
                            ? current.filter((id) => id !== candidate.id)
                            : [...current, candidate.id],
                        )
                      }
                      style={[
                        styles.choicePill,
                        selected && styles.choicePillSelected,
                        (busy || required) && styles.disabled,
                      ]}
                    >
                      <Text style={selected ? styles.choiceTextSelected : styles.choiceText}>
                        {labels[candidate.field] ?? candidate.field}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.helpFootnote}>名字必须确认。其他的，你说了算。</Text>

              <Pressable
                disabled={busy || approvedCandidateIds.length === 0}
                onPress={() => void approve()}
                style={[styles.primaryPill, (busy || approvedCandidateIds.length === 0) && styles.disabled]}
              >
                <Text style={styles.primaryText}>
                  {approvable.length === 0 ? "没有能确认的字段" : busy ? "带过来。" : "确认这些"}
                </Text>
              </Pressable>

              <Pressable
                disabled={busy}
                onPress={() => {
                  setReview(null);
                  setApprovedCandidateIds([]);
                  setMessage(null);
                }}
                style={styles.secondaryPill}
              >
                <Text style={styles.secondaryText}>换一张</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {approvedIdentity && !activated && (
        <View style={styles.activationBlock}>
          <Text style={styles.eyebrow}>SOCIAL ID</Text>
          <Text style={styles.activationTitle}>给 TA 一张出门证。</Text>
          <Text style={styles.bodyMuted}>只会带出你刚刚确认过、并且在下面再次选中的字段。</Text>

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
            {approvable
              .filter((candidate) => approvedCandidateIds.includes(candidate.id))
              .filter((candidate) => candidate.field !== "displayName")
              .map((candidate) => {
                const labels: Record<string, string> = {
                  identitySummary: "简介",
                  personaTraits: "性格",
                  speakingStyle: "说话方式",
                  values: "在意的事",
                  boundaries: "边界",
                };
                const selected = selectedSocialFields.includes(candidate.field);
                return (
                  <Pressable
                    key={candidate.id}
                    disabled={busy}
                    onPress={() =>
                      setSelectedSocialFields((current) =>
                        selected
                          ? current.filter((field) => field !== candidate.field)
                          : [...current, candidate.field],
                      )
                    }
                    style={[
                      styles.choicePill,
                      selected && styles.choicePillSelected,
                      busy && styles.disabled,
                    ]}
                  >
                    <Text style={selected ? styles.choiceTextSelected : styles.choiceText}>
                      {labels[candidate.field] ?? candidate.field}
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
            onPress={() => void activateSocialIdentity()}
            style={[styles.primaryPill, busy && styles.disabled]}
          >
            <Text style={styles.primaryText}>{busy ? "正在办。" : "让 TA 出门"}</Text>
          </Pressable>
        </View>
      )}

      {approvedIdentity && activated && (
        <View style={styles.activationBlock}>
          <Text style={styles.eyebrow}>READY</Text>
          <Text style={styles.activationTitle}>{approvedIdentity.displayName} 已经在这儿了。</Text>
          <Text style={styles.bodyMuted}>身份是 TA 的。切不切过去，是你的。</Text>
          {onOpenCompanion && (
            <Pressable
              onPress={() => onOpenCompanion(approvedIdentity)}
              style={styles.primaryPill}
            >
              <Text style={styles.primaryText}>去看看 TA</Text>
            </Pressable>
          )}
        </View>
      )}

      {message && <Text style={styles.message}>{message}</Text>}
    </ScrollView>
  );
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
  const [handle, setHandle] = useState(() => {
    const base = companion.displayName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const suffix = companion.companionId.replaceAll("-", "").slice(-4);
    return (base.length >= 3 ? base : "home") + "_" + suffix;
  });
  const [visibility, setVisibility] = useState<"PRIVATE" | "FRIENDS" | "PUBLIC">("PRIVATE");
  const [autonomy, setAutonomy] = useState<"QUIET" | "NORMAL" | "ACTIVE">("QUIET");
  const [selectedFields, setSelectedFields] = useState<string[]>(["displayName"]);
  const [busy, setBusy] = useState(false);
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
    if (busy) return;
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

    setBusy(true);
    setMessage(null);
    try {
      await api.projectSocialPersona(companion.companionId, {
        sourceIdentityVersionId: companion.identityId,
        handle: normalized,
        profileVisibility: visibility,
        autonomyMode: autonomy,
        selections,
      });
      setActivated(true);
      setMessage(`${companion.displayName} 可以出门了。`);
      onActivated?.();
    } catch (error) {
      setMessage(safeClientMessage(error).title);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
      <Text style={styles.eyebrow}>SOCIAL ID</Text>
      <Text style={styles.h1}>{companion.displayName}</Text>

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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  page: { padding: 20, paddingBottom: 48 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 28 },
  eyebrow: { fontSize: 10, letterSpacing: 1.2, color: colors.rose, fontWeight: "700" },
  h1: { marginTop: 7, fontSize: 30, lineHeight: 36, fontWeight: "700", color: colors.ink },
  h2: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.ink, textAlign: "center" },
  bodyMuted: { marginTop: 6, fontSize: 13, lineHeight: 20, color: colors.muted },
  micro: { marginTop: 4, fontSize: 11, lineHeight: 17, color: colors.tertiary },
  microStrong: { fontSize: 10, letterSpacing: 1, color: colors.rose, fontWeight: "700" },
  stack: { marginTop: 22, gap: 10 },
  card: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas },
  noticeCard: { padding: 14, borderRadius: 14, backgroundColor: colors.roseWash },
  cardTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  section: { marginTop: 26, gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.text },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  infoButton: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  infoButtonText: { fontSize: 11, fontWeight: "700", color: colors.tertiary },
  helpCard: { padding: 13, borderRadius: 14, backgroundColor: "#F8F8FA", gap: 7 },
  helpLine: { fontSize: 12, lineHeight: 18, color: colors.muted },
  helpStrong: { fontWeight: "700", color: colors.text },
  helpFootnote: { marginTop: 2, fontSize: 11, lineHeight: 17, color: colors.tertiary },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choicePill: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.line },
  choicePillSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceText: { fontSize: 12, color: colors.text },
  choiceTextSelected: { fontSize: 12, color: colors.canvas, fontWeight: "600" },
  toggleRow: { minHeight: 66, padding: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: "#D8D8DD", padding: 3 },
  toggleOn: { backgroundColor: colors.rose },
  toggleKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.canvas },
  toggleKnobOn: { alignSelf: "flex-end" },
  activationBlock: { marginTop: 26, paddingTop: 22, borderTopWidth: 1, borderColor: colors.line },
  activationTitle: { marginTop: 7, fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.ink },
  fieldLabel: { marginTop: 18, marginBottom: 8, fontSize: 12, fontWeight: "700", color: colors.text },
  shortInput: { minHeight: 44, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 14, color: colors.text, fontSize: 13 },
  importGuideCard: { marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: "#F8F8FA", borderWidth: 1, borderColor: colors.line },
  importGuideText: { marginTop: 8, fontSize: 12, lineHeight: 19, color: colors.muted },
  input: { minHeight: 180, marginTop: 22, padding: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 16, color: colors.text, textAlignVertical: "top", fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  primaryPill: { minHeight: 44, marginTop: 14, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 999, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.canvas, fontSize: 14, fontWeight: "600" },
  secondaryPill: { minHeight: 42, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 999, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  message: { marginTop: 18, textAlign: "center", fontSize: 13, color: colors.text },
  disabled: { opacity: 0.38 },
});
