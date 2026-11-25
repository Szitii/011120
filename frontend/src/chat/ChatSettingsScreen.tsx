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
  const [voiceDraft, setVoiceDraft] = useState<string | null>();
  const [models, setModels] = useState<ChatModelList>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [leaveSheetOpen, setLeaveSheetOpen] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const settingsRead = useRef(0);
  const voiceChanged = voiceDraft !== undefined;
  const saveDisabled = busy || (voiceChanged && !voices?.available);

  const handleBack = useCallback(() => {
    if (pending.current || deleting) return;
    if (connectionMode) {
      setConnectionMode(undefined);
      return;
    }
    if (voiceChanged) {
      setLeaveSheetOpen(true);
      return;
    }
    onBack?.();
  }, [connectionMode, deleting, onBack, voiceChanged]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!connectionMode && !onBack) return false;
      handleBack();
      return true;
    });
    return () => sub.remove();
  }, [connectionMode, handleBack, onBack]);

  useEffect(() => {
    const read = ++settingsRead.current;
    setBusy(true);
    setNotice("");
    setVoices(undefined);
    void client.listVoices?.().then(value => { if (read === settingsRead.current) setVoices(value); }).catch(() => { /* Older servers omit voices. */ });
    void client.getChatSettings(companionId).then(value => {
      if (read !== settingsRead.current) return;
      setForm(value);
      setVoiceDraft(draft => draft === value.voice ? undefined : draft);
    })
      .catch(problem => { if (read === settingsRead.current) setNotice(safeClientMessage(problem).title); })
      .finally(() => { if (read === settingsRead.current) setBusy(false); });
    setModelError(false);
    void client.listModels?.().then(value => { if (read === settingsRead.current) setModels(value); })
      .catch(() => { if (read === settingsRead.current) setModelError(true); });
    return () => { settingsRead.current++; pending.current = false; };
  }, [client, companionId, reload]);

  async function save() {
    if (!form || saveDisabled || pending.current) return;
    const read = settingsRead.current;
    pending.current = true;
    setBusy(true);
    setSaveNotice("");
    try {
      const { voice: _savedVoice, ...settings } = form;
      const saved = await client.updateChatSettings(companionId, voiceDraft === undefined ? settings : { ...settings, voice: voiceDraft });
      if (read !== settingsRead.current) return;
      setForm(saved);
      if (voiceDraft !== undefined && saved.voice !== voiceDraft) {
        setSaveNotice("服务端未确认新的音色，请核对后重试。");
      } else {
        setVoiceDraft(undefined);
        setSaveNotice(voiceChanged ? "音色已保存。" : "聊天设置已保存。");
      }
    } catch (error) {
      if (read !== settingsRead.current) return;
      if (error instanceof ApiProblemError && error.status === 409) {
        try {
          const latest = await client.getChatSettings(companionId);
          if (read !== settingsRead.current) return;
          setForm(latest);
          if (voiceDraft !== undefined && latest.voice !== voiceDraft) {
            setSaveNotice("设置已在别处更新。已保留你选的音色，其余设置已重新读取，请核对后再保存。");
          } else {
            setVoiceDraft(undefined);
            setSaveNotice(voiceChanged ? "已同步最新设置，所选音色已生效。" : "设置已在别处更新，请核对后再保存。");
          }
        } catch {
          if (read === settingsRead.current) {
            setForm(undefined);
            setSaveNotice("无法读取最新设置，请重新加载。");
          }
        }
      } else setSaveNotice(`保存失败。${safeClientMessage(error).title}`);
    } finally {
      if (read === settingsRead.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  async function confirmDelete() {
    if (!onDeleteCompanion) {
      setDeleteSheetOpen(false);
      setNotice("删除家机需要后端删除接口就绪后开放，目前已在排期中。");
      return;
    }
    const read = settingsRead.current;
    setDeleting(true);
    try {
      await onDeleteCompanion();
      if (read === settingsRead.current) setDeleteSheetOpen(false);
    } catch (error) {
      if (read === settingsRead.current) {
        setDeleteSheetOpen(false);
        setNotice(safeClientMessage(error).title);
      }
    } finally {
      if (read === settingsRead.current) setDeleting(false);
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
        {!!(notice || (!form && saveNotice)) && (
          <View style={s.noticeBanner}>
            <Text accessibilityLiveRegion="polite" style={s.noticeText}>{notice || saveNotice}</Text>
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
                <CommunityButton label="重新加载" onPress={() => {
                  setSaveNotice("");
                  setReload(value => value + 1);
                }} />
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
                    saved={form.voice}
                    selected={voiceDraft === undefined ? form.voice : voiceDraft}
                    disabled={busy}
                    onSelect={voice => {
                      setVoiceDraft(voice === (form.voice ?? null) ? undefined : voice);
                      setSaveNotice("");
                    }}
                  />
                )}

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

      {!connectionMode && form && (
        <View style={s.saveBar}>
          {(saveNotice || voiceChanged) && (
            <Text accessibilityLiveRegion="polite" style={s.noticeText}>
              {saveNotice || (voices?.available ? "音色尚未保存。" : "音色列表暂不可用，当前选择尚未保存。")}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={saveDisabled}
            onPress={() => void save()}
            style={({ pressed }) => [s.saveBtn, saveDisabled && { opacity: 0.55 }, pressed && { opacity: 0.85 }]}
          >
            <Text style={s.saveBtnText}>{busy ? "正在保存…" : "保存设置"}</Text>
          </Pressable>
        </View>
      )}

      <BottomSheet visible={leaveSheetOpen} title="音色尚未保存" onClose={() => setLeaveSheetOpen(false)}>
        <CommunityButton label="放弃更改并返回" onPress={() => { setLeaveSheetOpen(false); onBack?.(); }} />
      </BottomSheet>

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
    paddingBottom: 24,
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
  saveBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 6,
  },
  saveBtn: {
    height: 48,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
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
