import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CompanionPersona, PersonaWithExamplesInput } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";

type PersonaField = keyof Omit<PersonaWithExamplesInput, "version">;

const PRIMARY_FIELDS: ReadonlyArray<[PersonaField, string, string]> = [
  ["identitySummary", "简介", "TA 是谁、和你的基本背景…"],
  ["personaTraits", "性格", "性格特点、小习惯…"],
  ["speakingStyle", "说话风格", "语气、用词偏好…"],
];

const EXTRA_FIELDS: ReadonlyArray<[PersonaField, string, string]> = [
  ["values", "在意的事", "看重的原则或珍视的事物…"],
  ["boundaries", "边界", "不希望 TA 说或做的事…"],
  ["aspirations", "向往", "TA 的心愿或期待…"],
  ["dialogueExamples", "示例对话", "写几句你说的话和 TA 可能的回应…"],
];

const ALL_FIELDS: ReadonlyArray<PersonaField> = [
  "identitySummary",
  "personaTraits",
  "speakingStyle",
  "values",
  "boundaries",
  "aspirations",
  "dialogueExamples",
];

const fieldLimit = (field: PersonaField) => field === "dialogueExamples" ? 1500 : 600;

function personaRefusalMessage(reason?: string): string {
  switch (reason) {
    case "CREDENTIAL": return "这一栏里好像有密码或密钥，请去掉。";
    case "PRIVATE_DATA": return "这一栏里好像有邮箱或电话号码，请去掉（日期请写成 12月3日）。";
    case "INSTRUCTION": return "这一栏里有不能保存的指令，请换个说法。";
    case "LINK": return "这一栏里不能放链接。";
    default: return "这一栏包含不允许保存的内容，请修改后重试。";
  }
}

export function PersonaSettings({
  client,
  companionId,
  isExternal = false,
  initiallyExpanded = false,
}: {
  client: ChatClient;
  companionId: string;
  isExternal?: boolean;
  initiallyExpanded?: boolean;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [showMore, setShowMore] = useState(false);
  const [saved, setSaved] = useState<CompanionPersona>();
  const [draft, setDraft] = useState<Record<PersonaField, string>>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fieldError, setFieldError] = useState<{ field: PersonaField; message: string }>();
  const mounted = useRef(true);
  const pending = useRef(false);
  const reqId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    setSaved(undefined);
    setDraft(undefined);
    setNotice("");
    setFieldError(undefined);
    return () => { mounted.current = false; };
  }, [client, companionId]);

  const getPersona = client.getPersona;
  const savePersona = client.savePersona;

  const applyLoaded = useCallback((persona: CompanionPersona) => {
    setSaved(persona);
    setDraft({
      identitySummary: persona.identitySummary,
      personaTraits: persona.personaTraits,
      speakingStyle: persona.speakingStyle,
      values: persona.values,
      boundaries: persona.boundaries,
      aspirations: persona.aspirations,
      dialogueExamples: persona.dialogueExamples ?? "",
    });
  }, []);

  const load = useCallback(async () => {
    if (!getPersona || pending.current) return;
    pending.current = true;
    const version = ++reqId.current;
    setBusy(true);
    setNotice("");
    setFieldError(undefined);
    try {
      const persona = await getPersona(companionId);
      if (mounted.current && version === reqId.current) applyLoaded(persona);
    } catch (error) {
      if (mounted.current && version === reqId.current) setNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current && version === reqId.current) setBusy(false);
    }
  }, [getPersona, companionId, applyLoaded]);

  useEffect(() => {
    if (initiallyExpanded) void load();
  }, [initiallyExpanded, load]);

  if (!getPersona || !savePersona) return null;

  const changedPatch: Partial<Record<PersonaField, string>> = {};
  let hasOverLimit = false;
  if (saved && draft) {
    for (const key of ALL_FIELDS) {
      if (Array.from(draft[key]).length > fieldLimit(key)) hasOverLimit = true;
      if (draft[key] !== (saved[key] ?? "")) changedPatch[key] = draft[key];
    }
  }
  const hasChanges = Object.keys(changedPatch).length > 0;

  const save = async () => {
    if (!saved || !draft || !hasChanges || hasOverLimit || pending.current) return;
    pending.current = true;
    const version = ++reqId.current;
    setBusy(true);
    setNotice("");
    setFieldError(undefined);
    try {
      const updated = await savePersona(companionId, { version: saved.version, ...changedPatch });
      if (!mounted.current || version !== reqId.current) return;
      applyLoaded(updated);
      setNotice("已保存，下一条回复起生效。");
    } catch (error) {
      if (!mounted.current || version !== reqId.current) return;
      if (error instanceof ApiProblemError && error.status === 422 && error.code === "PERSONA_REFUSED") {
        const refusedField = ALL_FIELDS.find(f => f === error.field) ?? "identitySummary";
        setFieldError({ field: refusedField, message: personaRefusalMessage(error.reason) });
        if (EXTRA_FIELDS.some(([f]) => f === refusedField)) setShowMore(true);
      } else if (error instanceof ApiProblemError && error.status === 409) {
        try {
          const latest = await getPersona(companionId);
          if (!mounted.current || version !== reqId.current) return;
          applyLoaded(latest);
          setNotice("人设已在别处更新（或编辑过于频繁），已重新读取，请核对后再保存。");
        } catch {
          setNotice("人设已在别处更新，请重新读取。");
        }
      } else {
        setNotice(`保存失败。${safeClientMessage(error).title}`);
      }
    } finally {
      pending.current = false;
      if (mounted.current && version === reqId.current) setBusy(false);
    }
  };

  const renderField = ([key, label, placeholder]: readonly [PersonaField, string, string]) => {
    if (!draft) return null;
    const len = Array.from(draft[key]).length;
    const limit = fieldLimit(key);
    const isErr = fieldError?.field === key || len > limit;
    return (
      <View key={key} style={s.fieldWrap}>
        <View style={s.fieldHeader}>
          <Text style={s.fieldLabel}>{label}</Text>
          <Text style={[s.charCount, len > limit && s.errorText]}>{len} / {limit}</Text>
        </View>
        <TextInput
          accessibilityLabel={label}
          multiline
          maxLength={limit}
          editable={!busy}
          value={draft[key]}
          placeholder={placeholder}
          placeholderTextColor={ui.muted}
          onChangeText={text => {
            setDraft(prev => prev ? { ...prev, [key]: text } : prev);
            if (fieldError?.field === key) setFieldError(undefined);
            setNotice("");
          }}
          style={[s.input, isErr && s.inputError]}
        />
        {fieldError?.field === key && <Text accessibilityRole="alert" style={s.errorText}>{fieldError.message}</Text>}
      </View>
    );
  };

  return (
    <View style={s.card}>
      <Pressable
        accessibilityRole="button"
        style={s.rowHeader}
        disabled={busy}
        onPress={() => {
          const next = !expanded;
          setExpanded(next);
          if (next && !saved) void load();
        }}
      >
        <View style={s.headerLeft}>
          <Text style={s.title}>家机说明（人设）</Text>
          <Text style={s.subtitle}>随时微调 TA 的简介、性格与说话风格，下一条回复起生效</Text>
        </View>
        <View style={s.headerRight}>
          <Text style={s.countText}>{saved ? `v${saved.version}` : "编辑"}</Text>
          <Ionicons name={expanded ? "chevron-up" : "chevron-forward"} size={16} color={ui.muted} />
        </View>
      </Pressable>

      {expanded && (
        <View style={s.bodyWrap}>
          {isExternal && (
            <Text style={s.infoText}>
              当前已接入自建家机，此处人设不会发往你的外部私聊服务，仅在使用平台模型写日记和发动态时参考。
            </Text>
          )}
          {!!notice && <Text accessibilityLiveRegion="polite" style={s.noticeText}>{notice}</Text>}
          {!draft ? (
            busy ? (
              <ActivityIndicator accessibilityLabel="正在读取家机说明" color={ui.accent} style={{ marginVertical: 12 }} />
            ) : (
              <CommunityButton label="重新读取人设" disabled={busy} onPress={() => void load()} />
            )
          ) : (
            <>
              {PRIMARY_FIELDS.map(renderField)}
              <Pressable accessibilityRole="button" style={s.moreToggle} onPress={() => setShowMore(v => !v)}>
                <Text style={s.moreToggleText}>
                  {showMore ? "收起在意的事 / 边界 / 向往" : "展开更多（在意的事 / 边界 / 向往）"}
                </Text>
                <Ionicons name={showMore ? "chevron-up" : "chevron-down"} size={15} color={ui.accentInk} />
              </Pressable>
              {showMore && EXTRA_FIELDS.map(renderField)}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !hasChanges || hasOverLimit}
                onPress={() => void save()}
                style={({ pressed }) => [
                  s.saveBtn,
                  (busy || !hasChanges || hasOverLimit) && { opacity: 0.5 },
                  pressed && hasChanges && !busy && { opacity: 0.85 },
                ]}
              >
                <Text style={s.saveBtnText}>{busy ? "保存中…" : "保存人设"}</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  headerLeft: { flex: 1, gap: 2 },
  title: { fontSize: 15.5, fontWeight: "700", color: ui.ink },
  subtitle: { fontSize: 12, color: ui.muted },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  countText: { fontSize: 13, color: ui.muted, fontWeight: "500" },
  bodyWrap: { gap: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ui.line },
  infoText: { fontSize: 12.5, color: ui.muted, lineHeight: 18, backgroundColor: ui.background[0], padding: 10, borderRadius: 12 },
  noticeText: { fontSize: 13, color: ui.accentInk },
  fieldWrap: { gap: 6 },
  fieldHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fieldLabel: { fontSize: 13.5, fontWeight: "600", color: ui.ink },
  charCount: { fontSize: 11.5, color: ui.muted },
  input: {
    minHeight: 72,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    padding: 12,
    fontSize: 14,
    lineHeight: 20,
    color: ui.ink,
    textAlignVertical: "top",
  },
  inputError: { borderColor: ui.danger },
  errorText: { fontSize: 12.5, color: ui.danger },
  moreToggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 6 },
  moreToggleText: { fontSize: 13, fontWeight: "600", color: ui.accentInk },
  saveBtn: {
    height: 44,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { fontSize: 14.5, fontWeight: "700", color: ui.onAccent },
});
