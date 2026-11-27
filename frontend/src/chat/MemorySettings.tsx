import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CompanionMemory } from "../../../contracts/chat";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { useCommandKeys } from "../state/useCommandKeys";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";

function memorySourceLabel(source: string): string {
  if (source === "IMPORT") return "从角色卡导入";
  if (source === "OWNER") return "手动添加";
  if (source === "AUTO") return "TA 自己记的";
  return source || "长期记忆";
}

export function MemorySettings({ client, companionId }: { client: ChatClient; companionId: string }) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
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
  }, [client, companionId]);

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

  const bodyLen = Array.from(body.trim()).length;

  function add() {
    const value = body.trim();
    if (!client.addMemory || !items || !value || bodyLen > 500 || items.length >= 200) return;
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

  return (
    <View style={s.card}>
      <Pressable
        accessibilityRole="button"
        style={s.rowHeader}
        disabled={busy}
        onPress={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) { setConfirmId(undefined); void load(); }
        }}
      >
        <View style={s.headerLeft}>
          <Text style={s.title}>长期记忆</Text>
          <Text style={s.subtitle}>记忆会用于家机回复或日记。单条最多 500 字，请避开密码与私密资料</Text>
        </View>
        <View style={s.headerRight}>
          <Text style={s.countText}>
            {items ? `已存 ${items.length} / 200 条` : "管理"}
          </Text>
          <Ionicons name={expanded ? "chevron-up" : "chevron-forward"} size={16} color={ui.muted} />
        </View>
      </Pressable>

      {expanded && (
        <View style={s.bodyWrap}>
          {!!notice && <Text accessibilityRole="alert" style={s.error}>{notice}</Text>}
          {busy && !items && <Text accessibilityLiveRegion="polite" style={s.subtitle}>正在读取记忆…</Text>}
          {!busy && (!items || notice) && <CommunityButton label="重新读取记忆" onPress={() => void load()} />}
          {items && (
            <>
              <View style={s.inputBox}>
                <TextInput
                  accessibilityLabel="新记忆"
                  placeholder="写下一条值得 TA 记住的回忆…"
                  placeholderTextColor={ui.muted}
                  multiline
                  style={s.input}
                  value={body}
                  onChangeText={setBody}
                  editable={!busy}
                />
                <Text style={[s.charCount, bodyLen > 500 && s.error]}>
                  {bodyLen} / 500 字
                </Text>
              </View>
              <CommunityButton
                primary
                label="添加记忆"
                disabled={busy || !body.trim() || bodyLen > 500 || items.length >= 200}
                onPress={add}
              />
              {items.map(item => (
                <View key={item.id} style={s.itemCard}>
                  <Text selectable style={s.itemBody}>{item.body}</Text>
                  <View style={s.itemFooter}>
                    <Text style={s.itemMeta}>{memorySourceLabel(item.source)}</Text>
                    <View style={s.itemActions}>
                      {confirmId === item.id && (
                        <Pressable onPress={() => setConfirmId(undefined)} disabled={busy}>
                          <Text style={s.cancelText}>取消</Text>
                        </Pressable>
                      )}
                      <Pressable
                        disabled={busy}
                        onPress={() => {
                          if (confirmId === item.id) remove(item.id);
                          else setConfirmId(item.id);
                        }}
                      >
                        <Text style={s.deleteText}>{confirmId === item.id ? "确认删除" : "删除"}</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
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
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  headerLeft: { flex: 1, gap: 2 },
  title: { fontSize: 15.5, fontWeight: "700", color: ui.ink },
  subtitle: { fontSize: 12, color: ui.muted },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  countText: { fontSize: 13, color: ui.muted, fontWeight: "500" },
  bodyWrap: { gap: 10, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ui.line },
  inputBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    padding: 12,
    gap: 6,
  },
  input: {
    minHeight: 76,
    fontSize: 14,
    color: ui.ink,
    textAlignVertical: "top",
  },
  charCount: { fontSize: 11.5, color: ui.muted, textAlign: "right" },
  error: { fontSize: 12.5, color: ui.danger },
  itemCard: {
    borderRadius: 14,
    backgroundColor: ui.background[0],
    padding: 12,
    gap: 6,
  },
  itemBody: { fontSize: 13.5, lineHeight: 20, color: ui.ink },
  itemFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  itemMeta: { fontSize: 11.5, color: ui.muted },
  itemActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  cancelText: { fontSize: 12, color: ui.muted },
  deleteText: { fontSize: 12, color: ui.danger, fontWeight: "600" },
});
