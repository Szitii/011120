import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Text, TextInput, View } from "react-native";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton, useCommunityStyles } from "../community/components";
import type { AgentKey, ChatClient } from "./client";

export function AgentKeySettings({ companionId, list, create, revoke }: {
  companionId: string;
  list: NonNullable<ChatClient["listAgentKeys"]>;
  create: NonNullable<ChatClient["createAgentKey"]>;
  revoke: NonNullable<ChatClient["revokeAgentKey"]>;
}) {
  const s = useCommunityStyles();
  const [items, setItems] = useState<AgentKey[]>();
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [confirmId, setConfirmId] = useState<string>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const secretSession = useRef(0);

  const run = useCallback(async (operation: () => Promise<void>, onError: (error: unknown) => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) onError(error);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  const load = useCallback(() => run(async () => {
    const result = await list(companionId);
    if (mounted.current) setItems(result.items);
  }, error => {
    if (error instanceof ApiProblemError && [404, 501].includes(error.status)) {
      setItems(undefined);
      return;
    }
    setNotice("暂时无法读取 Agent 钥匙。");
  }), [companionId, list, run]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "background") return;
      secretSession.current++;
      setToken("");
    });
    return () => {
      mounted.current = false;
      secretSession.current++;
      subscription.remove();
    };
  }, [load]);

  const activeCount = items?.filter(item => item.active).length ?? 0;

  function createKey() {
    const label = name.trim();
    if (!items || !label || activeCount >= 5 || token) return;
    const session = secretSession.current;
    void run(async () => {
      const { token: oneTimeToken, ...key } = await create(companionId, label);
      if (!mounted.current) return;
      setItems(previous => [key, ...(previous ?? []).filter(item => item.id !== key.id)]);
      setName("");
      if (session === secretSession.current) setToken(oneTimeToken);
      else setNotice("钥匙已创建。由于页面已离开前台，密钥已隐藏，可作废后重新创建。");
    }, error => setNotice(error instanceof ApiProblemError && error.status === 409
      ? "有效钥匙可能已满，请刷新列表后再试。"
      : "无法确认是否已创建，请先刷新列表再试。"));
  }

  function revokeKey(id: string) {
    void run(async () => {
      const updated = await revoke(companionId, id);
      if (!mounted.current) return;
      setItems(previous => previous?.map(item => item.id === id ? updated : item));
      setConfirmId(undefined);
    }, error => setNotice(safeClientMessage(error).title));
  }

  if (!items && !notice) return null;

  return <View style={s.card}>
    <CommunityButton label={expanded ? "收起 Agent 签到钥匙" : "管理 Agent 签到钥匙"} disabled={busy} onPress={() => {
      setExpanded(!expanded);
      setToken("");
      setConfirmId(undefined);
    }} />
    {expanded && <>
      <Text style={s.meta}>外部 Agent 可用这把钥匙读取社区动态和家机通知。钥匙仅供签到，不能访问私聊和日记。</Text>
      <Text style={s.meta}>在外部服务中用这把钥匙作为 Bearer 凭证，请求 GET /v0/agent/heartbeat。</Text>
      {!!notice && <Text accessibilityRole="alert" style={s.error}>{notice}</Text>}
      {!!token && <View style={s.card}>
        <Text style={s.author}>请现在复制钥匙</Text>
        <Text style={s.meta}>关闭或离开页面后无法再查看。请只交给你信任的 Agent。</Text>
        <Text selectable style={s.body}>{token}</Text>
        <CommunityButton label="关闭密钥" onPress={() => setToken("")} />
      </View>}
      {!token && items && <>
        <Text style={s.meta}>有效钥匙 {activeCount}/5 · 新钥匙有效期 30 天</Text>
        <TextInput accessibilityLabel="钥匙名称" placeholder="给钥匙起个名字" style={s.input} maxLength={40}
          value={name} onChangeText={setName} editable={!busy && activeCount < 5} />
        <CommunityButton label="创建钥匙" disabled={busy || !name.trim() || activeCount >= 5} onPress={createKey} />
      </>}
      {(!items || !!notice) && <CommunityButton label="刷新钥匙列表" disabled={busy || !!token} onPress={() => void load()} />}
      {!token && items?.map(item => <View key={item.id} style={s.card}>
        <Text style={s.author}>{item.name}</Text>
        <Text style={s.meta}>{item.active ? "有效" : "已失效"} · 到期 {new Date(item.expiresAt).toLocaleString("zh-CN")}</Text>
        <Text style={s.meta}>{item.lastUsedAt ? `上次签到 ${new Date(item.lastUsedAt).toLocaleString("zh-CN")}` : "尚未签到"}</Text>
        {item.active && (confirmId === item.id ? <>
          <Text style={s.meta}>作废后，使用这把钥匙的 Agent 将无法继续签到。</Text>
          <CommunityButton label="确认作废" disabled={busy} onPress={() => revokeKey(item.id)} />
          <CommunityButton label="取消" disabled={busy} onPress={() => setConfirmId(undefined)} />
        </> : <CommunityButton label="作废钥匙" disabled={busy} onPress={() => setConfirmId(item.id)} />)}
      </View>)}
    </>}
  </View>;
}
