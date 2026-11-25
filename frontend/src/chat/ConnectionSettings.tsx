import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CompanionConnection } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { ConnectionForm } from "../onboarding/ConnectionForm";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { AgentKeySettings } from "./AgentKeySettings";
import type { ChatClient } from "./client";

export function ConnectionSettings({
  client,
  companionId,
  mode,
  onModeChange,
  enabled,
  onAvailabilityChanged,
}: {
  client: ChatClient;
  companionId: string;
  mode?: "key" | "external";
  onModeChange: (next?: "key" | "external") => void;
  enabled: boolean;
  onAvailabilityChanged: () => void;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(Boolean(mode));
  const [connection, setConnection] = useState<CompanionConnection>();
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);

  useEffect(() => {
    if (mode) setExpanded(true);
  }, [mode]);

  useEffect(() => {
    mounted.current = true;
    const version = ++request.current;
    const current = () => mounted.current && version === request.current;
    void client.getConnection?.(companionId).then(value => { if (current()) setConnection(value); })
      .catch(error => { if (current()) setNotice(safeClientMessage(error).title); });
    return () => { mounted.current = false; };
  }, [client, companionId]);

  async function revoke() {
    if (pending.current || !client.removeConnection) return;
    pending.current = true;
    request.current++;
    setRevoking(true);
    try {
      const value = await client.removeConnection(companionId);
      if (mounted.current) {
        setConnection(value);
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
  const kindLabel = connection?.kind === "BYOK"
    ? "自带 API Key"
    : connection?.kind === "EXTERNAL"
      ? "自建家机"
      : "平台托管";

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
                if (mounted.current) setConnection(result.connection);
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
              <Pressable style={s.optionRow} disabled={revoking} onPress={() => onModeChange("key")}>
                <Text style={s.optionLabel}>配置自带 API Key</Text>
                <Ionicons name="chevron-forward" size={16} color={ui.muted} />
              </Pressable>
              <Pressable style={s.optionRow} disabled={revoking} onPress={() => onModeChange("external")}>
                <Text style={s.optionLabel}>配置自建家机</Text>
                <Ionicons name="chevron-forward" size={16} color={ui.muted} />
              </Pressable>
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
  revokeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
