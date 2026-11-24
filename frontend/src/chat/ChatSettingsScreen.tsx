import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatModelList, ChatSettings, VoiceList } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { BottomSheet } from "../components/BottomSheet";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { CommunityButton } from "../community/components";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { ConnectionSettings } from "./ConnectionSettings";
import { MemorySettings } from "./MemorySettings";
import { VoicePicker } from "./VoicePicker";
import type { ChatClient } from "./client";

const ACTIVITY = [["QUIET", "安静"], ["NORMAL", "适中"], ["ACTIVE", "活跃"]] as const;
const INTERACTION = [["NONE", "不互动"], ["RARE", "偶尔"], ["NORMAL", "适中"], ["LIVELY", "热络"]] as const;
const TIER = { ECONOMY: "经济", STANDARD: "均衡", PREMIUM: "高级" };

export function ChatSettingsScreen({
  client,
  companionId,
  connectionKind,
  connectionsEnabled,
  groupSendEnabled,
  onAvailabilityChanged,
  onBack,
  onDeleteCompanion,
}: {
  client: ChatClient;
  companionId: string;
  connectionKind?: "key" | "external";
  connectionsEnabled: boolean;
  groupSendEnabled: boolean;
  onAvailabilityChanged: () => void;
  onBack?: () => void;
  onDeleteCompanion?: () => Promise<void>;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const [connectionMode, setConnectionMode] = useState<"key" | "external" | undefined>(connectionKind);
  const [form, setForm] = useState<ChatSettings>();
  const [voices, setVoices] = useState<VoiceList>();
  const [voiceChanged, setVoiceChanged] = useState(false);
  const [models, setModels] = useState<ChatModelList>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [modelError, setModelError] = useState(false);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  const handleBack = useCallback(() => {
    if (connectionMode) {
      setConnectionMode(undefined);
      return;
    }
    onBack?.();
  }, [connectionMode, onBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (connectionMode) {
        setConnectionMode(undefined);
        return true;
      }
      if (onBack) {
        onBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [connectionMode, onBack]);

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

  async function confirmDelete() {
    if (!onDeleteCompanion) {
      setDeleteSheetOpen(false);
      setNotice("删除家机需要后端删除接口就绪后开放，目前已在排期中。");
      return;
    }
    setDeleting(true);
    try {
      await onDeleteCompanion();
      if (mounted.current) setDeleteSheetOpen(false);
    } catch (error) {
      if (mounted.current) {
        setDeleteSheetOpen(false);
        setNotice(safeClientMessage(error).title);
      }
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  const usableModels = (models?.items ?? []).filter(m => m.available);

  return (
    <View style={s.root}>
      {onBack && (
        <View style={s.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={connectionMode ? "返回聊天设置" : "返回"}
            onPress={handleBack}
            style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.78 }]}
          >
            <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={StyleSheet.absoluteFill} />
            <Ionicons name="chevron-back" size={19} color={ui.ink} />
          </Pressable>
          <Text accessibilityRole="header" style={s.headerTitle}>
            {connectionMode === "key" ? "自带 API Key" : connectionMode === "external" ? "连接自建家机" : "聊天设置"}
          </Text>
          <View style={s.headerSpacer} />
        </View>
      )}

      <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {!!notice && (
          <View style={s.noticeBanner}>
            <Text accessibilityLiveRegion="polite" style={s.noticeText}>{notice}</Text>
          </View>
        )}

        {client.saveConnection && (
          <ConnectionSettings
            client={client}
            companionId={companionId}
            mode={connectionMode}
            onModeChange={setConnectionMode}
            enabled={connectionsEnabled}
            onAvailabilityChanged={onAvailabilityChanged}
          />
        )}

        {!connectionMode && (
          <>
            {client.listMemories && <MemorySettings client={client} companionId={companionId} />}

            {!form ? (
              busy ? (
                <ActivityIndicator accessibilityLabel="正在读取聊天设置" color={ui.accent} style={{ marginVertical: 20 }} />
              ) : (
                <CommunityButton label="重新加载" onPress={() => setReload(value => value + 1)} />
              )
            ) : (
              <>
                {groupSendEnabled && (
                  <View style={s.card}>
                    <Text style={s.sectionTitle}>群聊活跃度</Text>
                    <View style={s.pillRow}>
                      {ACTIVITY.map(([value, label]) => (
                        <CommunityButton
                          key={value}
                          label={label}
                          disabled={busy}
                          selected={form.groupActivity === value}
                          onPress={() => setForm({ ...form, groupActivity: value })}
                        />
                      ))}
                    </View>
                    <Text style={[s.sectionTitle, { marginTop: 8 }]}>家机互动倾向</Text>
                    <View style={s.pillRow}>
                      {INTERACTION.map(([value, label]) => (
                        <CommunityButton
                          key={value}
                          label={label}
                          disabled={busy}
                          selected={form.companionInteraction === value}
                          onPress={() => setForm({ ...form, companionInteraction: value })}
                        />
                      ))}
                    </View>
                  </View>
                )}

                {(
                  <View style={s.card}>
                    <Text style={s.sectionTitle}>聊天模型</Text>
                    <CommunityButton
                      label="使用平台默认"
                      disabled={busy}
                      selected={form.model === null}
                      onPress={() => setForm({ ...form, model: null })}
                    />
                    {usableModels.map(model => (
                      <CommunityButton
                        key={model.id}
                        label={`${model.name} · ${TIER[model.tier]}`}
                        selected={model.id === form.model}
                        disabled={busy}
                        onPress={() => setForm({ ...form, model: model.id })}
                      />
                    ))}
                    {form.model && !usableModels.some(model => model.id === form.model) && <Text style={s.mutedText}>当前所选模型暂不可用，原设置仍保留。</Text>}
                    {!modelError && models && !models.defaultModel && <Text style={s.mutedText}>平台默认模型暂不可用。</Text>}
                    {modelError && <Text style={s.mutedText}>暂时无法读取模型列表，当前设置仍会保留。</Text>}
                  </View>
                )}

                {voices?.available && (
                  <VoicePicker
                    voices={voices.items}
                    sample={client.voiceSample}
                    selected={form.voice}
                    disabled={busy}
                    onSelect={voice => {
                      setVoiceChanged(true);
                      setForm({ ...form, voice });
                    }}
                  />
                )}

                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void save()}
                  style={({ pressed }) => [s.saveBtn, busy && { opacity: 0.55 }, pressed && { opacity: 0.85 }]}
                >
                  <Text style={s.saveBtnText}>{busy ? "正在保存…" : "保存设置"}</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  disabled={busy || deleting}
                  onPress={() => setDeleteSheetOpen(true)}
                  style={({ pressed }) => [s.deleteBtn, pressed && { opacity: 0.78 }]}
                >
                  <Text style={s.deleteBtnText}>删除这位家机</Text>
                </Pressable>
              </>
            )}
          </>
        )}
      </ScrollView>

      <BottomSheet visible={deleteSheetOpen} title="删除这位家机？" onClose={() => { if (!deleting) setDeleteSheetOpen(false); }}>
        <View style={{ gap: 12 }}>
          <Text style={s.mutedText}>
            {onDeleteCompanion
              ? "删除后将无法恢复该家机的聊天与小家记录，请确认是否继续。"
              : "服务端删除家机接口正在接入中，上线后即可在这里一键移除不需要的家机。"}
          </Text>
          <CommunityButton
            label={deleting ? "正在删除…" : onDeleteCompanion ? "确认删除" : "我知道了"}
            disabled={deleting}
            onPress={() => void confirmDelete()}
          />
        </View>
      </BottomSheet>
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: 10,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 16.5, fontWeight: "700", color: ui.ink },
  headerSpacer: { width: 38 },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 6,
    paddingBottom: CHROME.scrollBottomClearance + 24,
    gap: 14,
  },
  noticeBanner: {
    borderRadius: 14,
    backgroundColor: ui.accentWash,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  noticeText: { fontSize: 13, color: ui.accentInk },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    padding: 16,
    gap: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: ui.ink },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mutedText: { fontSize: 13, color: ui.muted, lineHeight: 19 },
  saveBtn: {
    height: 48,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  saveBtnText: { fontSize: 15, fontWeight: "700", color: ui.onAccent },
  deleteBtn: {
    height: 46,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBtnText: { fontSize: 14.5, fontWeight: "600", color: ui.danger },
});
