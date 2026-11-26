import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CompanionConnection } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import type { OwnerCompanionSummary } from "../contracts";
import { Check } from "../onboarding/BringControls";
import { connectionMessage, providerPresets, type ProviderId } from "../onboarding/connection-client";
import { ConnectionForm } from "../onboarding/ConnectionForm";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { AgentKeySettings } from "./AgentKeySettings";
import type { ChatClient } from "./client";

type ReusableSource = { companion: OwnerCompanionSummary; connection: CompanionConnection };

function reusableLabel(conn: CompanionConnection): string {
  if (conn.kind === "EXTERNAL") return conn.name ? `自建家机 · ${conn.name}` : "自建家机";
  const preset = conn.provider && conn.provider in providerPresets
    ? providerPresets[conn.provider as Exclude<ProviderId, "custom">].label
    : conn.provider ?? "自定义模型";
  return conn.keyHint ? `${preset} · ••••${conn.keyHint}` : preset;
}

export function ConnectionSettings({
  client,
  companionId,
  companions = [],
  mode,
  onModeChange,
  enabled,
  onAvailabilityChanged,
  onConnectionChange,
}: {
  client: ChatClient;
  companionId: string;
  companions?: OwnerCompanionSummary[];
  mode?: "key" | "external";
  onModeChange: (next?: "key" | "external") => void;
  enabled: boolean;
  onAvailabilityChanged: () => void;
  onConnectionChange?: (connection?: CompanionConnection) => void;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(Boolean(mode));
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargetId, setCopyTargetId] = useState<string>();
  const [copyConsent, setCopyConsent] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const [reusable, setReusable] = useState<ReusableSource[]>([]);
  const [connection, setConnection] = useState<CompanionConnection>();
  const [loading, setLoading] = useState(Boolean(client.getConnection));
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);
  const onConnChangeRef = useRef(onConnectionChange);
  onConnChangeRef.current = onConnectionChange;

  useEffect(() => {
    if (mode) {
      setExpanded(true);
      setCopyOpen(false);
    }
  }, [mode]);

  useEffect(() => {
    mounted.current = true;
    const version = ++request.current;
    const current = () => mounted.current && version === request.current;
    setConnection(undefined);
    onConnChangeRef.current?.(undefined);
    setNotice("");
    setLoadError(false);
    setCopyOpen(false);
    setCopyTargetId(undefined);
    setCopyConsent(false);
    setCopyNotice("");
    setReusable([]);
    if (!client.getConnection) {
      setLoading(false);
      async function submitCopy() {
    if (pending.current || copyBusy || !copyTargetId || !copyConsent) return;
    const selected = reusable.find(item => item.companion.companionId === copyTargetId);
    if (!selected) return;
    pending.current = true;
    setCopyBusy(true);
    setCopyNotice("");
    setNotice("");
    request.current++;
    try {
      const result = await save(companionId, { copyFrom: copyTargetId, consent: true });
      if (!mounted.current) return;
      if (result.result === "CONNECTED") {
        setConnection(result.connection);
        onConnChangeRef.current?.(result.connection);
        setCopyOpen(false);
        setCopyConsent(false);
        setNotice("已沿用连接并保存。");
      } else {
        setCopyNotice(connectionMessage(result, selected.connection.kind === "EXTERNAL" ? "external" : "key"));
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiProblemError && error.status === 501) onAvailabilityChanged();
      setCopyNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  }

  return () => { mounted.current = false; };
    }
    const getConn = client.getConnection;
    setLoading(true);
    void getConn(companionId).then(value => {
      if (!current()) return;
      setConnection(value);
      onConnChangeRef.current?.(value);
      setLoadError(false);
    }).catch(error => {
      if (!current()) return;
      setLoadError(true);
      setNotice(safeClientMessage(error).title);
    }).finally(() => {
      if (current()) setLoading(false);
    });

    const others = companions.filter(item => item.companionId !== companionId);
    if (others.length > 0) {
      void Promise.allSettled(
        others.map(async item => ({ companion: item, connection: await getConn(item.companionId) })),
      ).then(results => {
        if (!current()) return;
        const connected = results
          .filter((r): r is PromiseFulfilledResult<ReusableSource> => r.status === "fulfilled" && r.value.connection.kind !== "PLATFORM");
        setReusable(connected.map(r => r.value));
      });
    }
    async function submitCopy() {
    if (pending.current || copyBusy || !copyTargetId || !copyConsent) return;
    const selected = reusable.find(item => item.companion.companionId === copyTargetId);
    if (!selected) return;
    pending.current = true;
    setCopyBusy(true);
    setCopyNotice("");
    setNotice("");
    request.current++;
    try {
      const result = await save(companionId, { copyFrom: copyTargetId, consent: true });
      if (!mounted.current) return;
      if (result.result === "CONNECTED") {
        setConnection(result.connection);
        onConnChangeRef.current?.(result.connection);
        setCopyOpen(false);
        setCopyConsent(false);
        setNotice("已沿用连接并保存。");
      } else {
        setCopyNotice(connectionMessage(result, selected.connection.kind === "EXTERNAL" ? "external" : "key"));
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiProblemError && error.status === 501) onAvailabilityChanged();
      setCopyNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  }

  return () => { mounted.current = false; };
  }, [client, companionId, companions]);

  async function revoke() {
    if (pending.current || !client.removeConnection) return;
    pending.current = true;
    request.current++;
    setRevoking(true);
    try {
      const value = await client.removeConnection(companionId);
      if (mounted.current) {
        setConnection(value);
        onConnChangeRef.current?.(value);
        setConfirm(false);
        setNotice("已恢复平台托管。");
      }
    } catch (error) {
      if (mounted.current) setNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setRevoking(false);
    }
  }

  useEffect(() => {
    if (!enabled && mode) onModeChange(undefined);
  }, [enabled, mode, onModeChange]);

  if (!client.saveConnection) return null;
  const save = client.saveConnection;
  const kindLabel = loading && !connection
    ? "读取中…"
    : !connection && loadError
      ? "读取失败"
      : connection?.kind === "BYOK"
        ? "自带 API Key"
        : connection?.kind === "EXTERNAL"
          ? "自建家机"
          : "平台托管";

  async function submitCopy() {
    if (pending.current || copyBusy || !copyTargetId || !copyConsent) return;
    const selected = reusable.find(item => item.companion.companionId === copyTargetId);
    if (!selected) return;
    pending.current = true;
    setCopyBusy(true);
    setCopyNotice("");
    setNotice("");
    request.current++;
    try {
      const result = await save(companionId, { copyFrom: copyTargetId, consent: true });
      if (!mounted.current) return;
      if (result.result === "CONNECTED") {
        setConnection(result.connection);
        onConnChangeRef.current?.(result.connection);
        setCopyOpen(false);
        setCopyConsent(false);
        setNotice("已沿用连接并保存。");
      } else {
        setCopyNotice(connectionMessage(result, selected.connection.kind === "EXTERNAL" ? "external" : "key"));
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiProblemError && error.status === 501) onAvailabilityChanged();
      setCopyNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  }

  return (
    <View style={s.card}>
      <Pressable
        accessibilityRole="button"
        style={s.rowHeader}
        onPress={() => {
          if (mode) onModeChange(undefined);
          else setExpanded(prev => !prev);
        }}
      >
        <Text style={s.title}>家机连接方式</Text>
        <View style={s.headerRight}>
          <Text style={s.valueText}>
            {kindLabel}{connection?.keyHint ? ` · ••••${connection.keyHint}` : ""}
          </Text>
          <Ionicons name={expanded || mode ? "chevron-up" : "chevron-forward"} size={16} color={ui.muted} />
        </View>
      </Pressable>

      {!!notice && <Text accessibilityRole="alert" style={s.notice}>{notice}</Text>}

      {enabled && mode ? (
        <View style={s.bodyWrap}>
          <ConnectionForm
            key={mode}
            kind={mode}
            onClose={() => onModeChange(undefined)}
            submitConnection={async input => {
              request.current++;
              setNotice("");
              try {
                const result = await save(companionId, input);
                if (mounted.current) {
                  setConnection(result.connection);
                  onConnChangeRef.current?.(result.connection);
                }
                return result;
              } catch (error) {
                if (error instanceof ApiProblemError && error.status === 501) onAvailabilityChanged();
                throw error;
              }
            }}
          />
        </View>
      ) : expanded ? (
        <View style={s.bodyWrap}>
          {enabled ? (
            <View style={s.optionList}>
              <Pressable style={s.optionRow} disabled={revoking || copyBusy} onPress={() => onModeChange("key")}>
                <Text style={s.optionLabel}>配置自带 API Key</Text>
                <Ionicons name="chevron-forward" size={16} color={ui.muted} />
              </Pressable>
              <Pressable style={s.optionRow} disabled={revoking || copyBusy} onPress={() => onModeChange("external")}>
                <Text style={s.optionLabel}>配置自建家机</Text>
                <Ionicons name="chevron-forward" size={16} color={ui.muted} />
              </Pressable>
              {reusable.length > 0 && (
                <>
                  <Pressable
                    style={s.optionRow}
                    disabled={revoking || copyBusy}
                    onPress={() => {
                      setCopyOpen(prev => !prev);
                      setCopyNotice("");
                      if (!copyTargetId && reusable[0]) setCopyTargetId(reusable[0].companion.companionId);
                    }}
                  >
                    <Text style={s.optionLabel}>和另一个家机用同一个连接</Text>
                    <Ionicons name={copyOpen ? "chevron-up" : "chevron-forward"} size={16} color={ui.muted} />
                  </Pressable>
                  {copyOpen && (
                    <View style={s.copyPanel}>
                      <Text style={s.mutedText}>选择一个已配置连接的家机（服务端直接复制配置，无需重填密钥）：</Text>
                      {reusable.map(({ companion, connection: src }) => {
                        const selected = copyTargetId === companion.companionId;
                        return (
                          <Pressable
                            key={companion.companionId}
                            accessibilityRole="button"
                            disabled={copyBusy}
                            onPress={() => { setCopyTargetId(companion.companionId); setCopyNotice(""); }}
                            style={[s.copyItem, selected && s.copyItemSelected]}
                          >
                            <View style={{ flex: 1, gap: 2 }}>
                              <Text style={s.optionLabel}>{companion.displayName}</Text>
                              <Text style={s.mutedText}>{reusableLabel(src)}</Text>
                            </View>
                            {selected && <Ionicons name="checkmark-circle" size={18} color={ui.accent} />}
                          </Pressable>
                        );
                      })}
                      <Check
                        checked={copyConsent}
                        onPress={() => setCopyConsent(prev => !prev)}
                        label="我同意将该家机的聊天内容与记忆摘要发往所选服务商或自建服务。"
                      />
                      {!!copyNotice && <Text accessibilityRole="alert" style={s.notice}>{copyNotice}</Text>}
                      <CommunityButton
                        primary
                        label={copyBusy ? "正在测试连接…" : "沿用并测试连接"}
                        disabled={copyBusy || !copyTargetId || !copyConsent}
                        onPress={() => void submitCopy()}
                      />
                    </View>
                  )}
                </>
              )}
            </View>
          ) : (
            <Text style={s.mutedText}>连接自己的模型暂未开放。</Text>
          )}

          {connection && connection.kind !== "PLATFORM" && (
            <View style={s.revokeRow}>
              <CommunityButton
                label={confirm ? "确认撤销连接" : "恢复平台托管"}
                disabled={revoking}
                onPress={() => (confirm ? void revoke() : setConfirm(true))}
              />
              {confirm && <CommunityButton label="取消" disabled={revoking} onPress={() => setConfirm(false)} />}
            </View>
          )}

          {client.listAgentKeys && client.createAgentKey && client.revokeAgentKey && (
            <AgentKeySettings
              key={companionId}
              companionId={companionId}
              list={client.listAgentKeys}
              create={client.createAgentKey}
              revoke={client.revokeAgentKey}
            />
          )}
        </View>
      ) : null}
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
    gap: 10,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  title: { fontSize: 15.5, fontWeight: "700", color: ui.ink },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  valueText: { fontSize: 13.5, color: ui.muted },
  notice: { fontSize: 13, color: ui.accentInk },
  bodyWrap: { gap: 10, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ui.line },
  optionList: { gap: 8 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: ui.background[0],
  },
  optionLabel: { fontSize: 14, fontWeight: "600", color: ui.ink },
  mutedText: { fontSize: 13, color: ui.muted },
  copyPanel: {
    gap: 10,
    padding: 12,
    borderRadius: 16,
    backgroundColor: ui.background[0],
  },
  copyItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  copyItemSelected: {
    borderColor: ui.accent,
    backgroundColor: ui.accentWash,
  },
  revokeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
