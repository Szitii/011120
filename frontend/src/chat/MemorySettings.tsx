import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { CompanionMemory } from "../../../contracts/chat";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton, useCommunityStyles } from "../community/components";
import { useCommandKeys } from "../state/useCommandKeys";
import type { ChatClient } from "./client";

export function MemorySettings({ client, companionId }: { client: ChatClient; companionId: string }) {
  const s = useCommunityStyles();
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<CompanionMemory[]>();
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string>();
  const mounted = useRef(true);
  const pending = useRef(false);
  const keys = useCommandKeys();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setNotice(safeClientMessage(error).title);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const load = () => run(async () => {
    const result = await client.listMemories?.(companionId);
    if (mounted.current && result) setItems(result.items);
  });

  function add() {
    const value = body.trim();
    if (!client.addMemory || !items || !value || Array.from(value).length > 500 || items.length >= 200) return;
    const addMemory = client.addMemory;
    void run(async () => {
      const item = await addMemory(companionId, value, keys.forRequest("memory", value));
      if (!mounted.current) return;
      keys.complete("memory");
      setItems(previous => [item, ...(previous ?? []).filter(memory => memory.id !== item.id)]);
      setBody("");
    });
  }

  function remove(id: string) {
    if (!client.deleteMemory) return;
    const deleteMemory = client.deleteMemory;
    void run(async () => {
      await deleteMemory(companionId, id);
      if (!mounted.current) return;
      setItems(previous => previous?.filter(item => item.id !== id));
      setConfirmId(undefined);
    });
  }

  return <View style={s.card}>
    <CommunityButton label={expanded ? "收起长期记忆" : "管理长期记忆"} disabled={busy} onPress={() => {
      setExpanded(!expanded);
      if (!expanded) void load();
    }} />
    {expanded && <>
      {!!notice && <Text accessibilityRole="alert" style={s.error}>{notice}</Text>}
      {!items && <CommunityButton label="重新读取记忆" disabled={busy} onPress={() => void load()} />}
      {items && <>
        <Text style={s.meta}>记忆会用于家机回复或日记。请避开密码和私密资料。 · {items.length}/200</Text>
        <TextInput accessibilityLabel="新记忆" placeholder="写下一条回忆" multiline style={s.input} value={body}
          onChangeText={setBody} editable={!busy} />
        <CommunityButton label="添加记忆" disabled={busy || !body.trim() || Array.from(body.trim()).length > 500 || items.length >= 200} onPress={add} />
        {items.map(item => <View key={item.id} style={s.card}>
          <Text selectable style={s.body}>{item.body}</Text>
          <Text style={s.meta}>{item.source === "IMPORT" ? "从角色卡导入" : "手动添加"}</Text>
          <CommunityButton label={confirmId === item.id ? "确认删除记忆" : "删除记忆"} disabled={busy} onPress={() => {
            if (confirmId === item.id) remove(item.id);
            else setConfirmId(item.id);
          }} />
          {confirmId === item.id && <CommunityButton label="取消" disabled={busy} onPress={() => setConfirmId(undefined)} />}
        </View>)}
      </>}
    </>}
  </View>;
}
