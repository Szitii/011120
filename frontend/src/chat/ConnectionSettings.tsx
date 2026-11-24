import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { CompanionConnection } from "../../../contracts/chat";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton, useCommunityStyles } from "../community/components";
import { ConnectionForm } from "../onboarding/ConnectionForm";
import type { ChatClient } from "./client";

export function ConnectionSettings({ client, companionId, initialKind }: {
  client: ChatClient;
  companionId: string;
  initialKind?: "key" | "external";
}) {
  const s = useCommunityStyles();
  const [mode, setMode] = useState(initialKind);
  const [connection, setConnection] = useState<CompanionConnection>();
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const request = useRef(0);

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

  if (!client.saveConnection) return null;
  const save = client.saveConnection;
  return <View style={s.card}>
    <Text style={s.author}>家机连接方式</Text>
    {connection && <Text style={s.body}>{connection.kind === "BYOK" ? "自带 API Key" : connection.kind === "EXTERNAL" ? "自建家机" : "平台托管"}
      {connection.keyHint ? ` · ••••${connection.keyHint}` : ""}</Text>}
    {!!notice && <Text accessibilityRole="alert" style={s.body}>{notice}</Text>}
    {mode ? <ConnectionForm key={mode} kind={mode} onClose={() => setMode(undefined)} submitConnection={async input => {
      request.current++;
      setNotice("");
      const result = await save(companionId, input);
      if (mounted.current) setConnection(result.connection);
      return result.result;
    }} /> : <>
      <CommunityButton label="配置自带 API Key" disabled={revoking} onPress={() => setMode("key")} />
      <CommunityButton label="配置自建家机" disabled={revoking} onPress={() => setMode("external")} />
      {connection && connection.kind !== "PLATFORM" && <>
        <CommunityButton label={confirm ? "确认撤销连接" : "恢复平台托管"} disabled={revoking}
          onPress={() => confirm ? void revoke() : setConfirm(true)} />
        {confirm && <CommunityButton label="取消" disabled={revoking} onPress={() => setConfirm(false)} />}
      </>}
    </>}
  </View>;
}
