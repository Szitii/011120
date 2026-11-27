import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { CompanionSkills, OwnSkill, WorldEntry } from "../../../contracts/chat";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton } from "../community/components";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";

type Entry = { id: string; label: string; body: string; enabled: boolean };
type Draft = Omit<Entry, "id"> & { id?: string };
type Catalog = { entries: Entry[]; skills?: CompanionSkills };
const emptyDraft: Draft = { label: "", body: "", enabled: true };

function worldEntry(entry: WorldEntry): Entry {
  return { id: entry.id, label: entry.keys.join("\n"), body: entry.body, enabled: entry.enabled };
}
function ownSkill(skill: OwnSkill): Entry {
  return { id: skill.id, label: skill.title, body: skill.body, enabled: skill.enabled };
}
const splitKeys = (text: string) => [...new Set(text.split(/\r?\n/).map(key => key.trim()).filter(Boolean))];
const length = (text: string) => Array.from(text).length;

export function ChatKnowledgeSettings({ client, companionId, kind }: {
  client: ChatClient;
  companionId: string;
  kind: "world" | "skills";
}) {
  const styles = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const world = kind === "world";
  const title = world ? "世界书" : "技能";
  const supported = world
    ? Boolean(client.listWorldEntries && client.saveWorldEntry && client.deleteWorldEntry)
    : Boolean(client.listSkills && client.toggleOfficialSkill && client.saveOwnSkill && client.deleteOwnSkill);
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>();
  const [draft, setDraft] = useState<Draft>();
  const [confirmation, setConfirmation] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [refusal, setRefusal] = useState<{ field: "label" | "body"; text: string }>();
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setRefusal(undefined);
    try {
      await work();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiProblemError && error.status === 422 && ["WORLD_ENTRY_REFUSED", "SKILL_REFUSED"].includes(error.code)) {
        const reasons: Record<string, string> = {
          CREDENTIAL: "检测到疑似密码或密钥，请移除后重试。",
          PRIVATE_DATA: "检测到邮箱或电话等私密信息，请移除后重试。",
          INSTRUCTION: "这段内容无法作为设定保存，请换个说法。",
          LINK: "请移除链接后重试。",
        };
        setRefusal({ field: error.field === "body" ? "body" : "label", text: reasons[error.reason ?? ""] ?? "此处内容未通过检查。" });
      } else {
        setNotice(error instanceof ApiProblemError && error.status === 409
          ? (world ? "世界书最多 100 条。" : "最多开启 5 个技能，自定义技能最多 10 个。") : safeClientMessage(error).title);
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const applySkills = (skills: CompanionSkills) => {
    if (active.current) setCatalog({ entries: skills.own.map(ownSkill), skills });
  };
  const load = () => run(async () => {
    if (world) {
      const result = await client.listWorldEntries!(companionId);
      if (active.current) setCatalog({ entries: result.items.map(worldEntry) });
    } else applySkills(await client.listSkills!(companionId));
  });

  function updateEntry(saved: Entry) {
    setCatalog(current => {
      if (!current) return current;
      const present = current.entries.some(entry => entry.id === saved.id);
      return { ...current, entries: present
        ? current.entries.map(entry => entry.id === saved.id ? saved : entry)
        : [...current.entries, saved] };
    });
  }

  const keys = draft && world ? splitKeys(draft.label) : [];
  const validLabel = draft && (world
    ? keys.length >= 1 && keys.length <= 8 && keys.every(key => length(key) <= 40 && !/[\r\n]/.test(key))
    : length(draft.label.trim()) >= 1 && length(draft.label.trim()) <= 20 && !/[\r\n]/.test(draft.label));
  const bodyLimit = world ? 1000 : 600;
  const validDraft = !!(draft && validLabel && draft.body.trim() && length(draft.body.trim()) <= bodyLimit);
  const maxItems = world ? 100 : 10;
  const enabled = (catalog?.entries.filter(entry => entry.enabled).length ?? 0)
    + (catalog?.skills?.official.filter(skill => skill.enabled).length ?? 0);

  function save() {
    if (!draft || !validDraft) return;
    const { id, label, body, enabled } = draft;
    void run(async () => {
      const saved = world
        ? worldEntry(await client.saveWorldEntry!(companionId, { keys, body: body.trim(), enabled }, id))
        : ownSkill(await client.saveOwnSkill!(companionId, { title: label.trim(), body: body.trim(), enabled }, id));
      if (active.current) { updateEntry(saved); setDraft(undefined); }
    });
  }

  function remove(id: string) {
    void run(async () => {
      if (world) await client.deleteWorldEntry!(companionId, id);
      else await client.deleteOwnSkill!(companionId, id);
      if (!active.current) return;
      setCatalog(current => current && { ...current, entries: current.entries.filter(entry => entry.id !== id) });
      setConfirmation(undefined);
      if (draft?.id === id) setDraft(undefined);
    });
  }

  if (!supported) return null;
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} disabled={busy}
        onPress={() => { setExpanded(!expanded); if (!expanded) void load(); }} style={styles.heading}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.meta}>{expanded ? "收起" : "管理"}</Text>
      </Pressable>
      {expanded && <>
        {notice !== "" && <Text accessibilityRole="alert" style={styles.error}>{notice}</Text>}
        {busy && <Text accessibilityLiveRegion="polite" style={styles.meta}>正在处理…</Text>}
        {!busy && (!catalog || notice) && <CommunityButton label="重新读取" onPress={() => void load()} />}
        {catalog?.skills && <>
          <Text style={styles.meta}>已开启 {enabled} / {catalog.skills.maxEnabled}</Text>
          {catalog.skills.official.map(skill => (
            <View key={skill.id} style={styles.entry}>
              <View style={styles.heading}>
                <Text style={styles.title}>{skill.title}</Text>
                <Switch value={skill.enabled} disabled={busy} accessibilityLabel={skill.title}
                  onValueChange={value => void run(async () => applySkills(await client.toggleOfficialSkill!(companionId, skill.id, value)))} />
              </View>
              {!!skill.summary && <Text style={styles.meta}>{skill.summary}</Text>}
            </View>
          ))}
          <Text style={styles.title}>我写的技能</Text>
        </>}
        {catalog?.entries.map(entry => (
          <View key={entry.id} style={styles.entry}>
            <Text style={styles.title}>{entry.label}</Text>
            <Text style={styles.meta} numberOfLines={3}>{entry.body}</Text>
            <Text style={styles.meta}>{entry.enabled ? "已开启" : "已关闭"}</Text>
            <View style={styles.actions}>
              <CommunityButton label="编辑" disabled={busy} onPress={() => {
                setConfirmation(undefined); setRefusal(undefined); setDraft(entry);
              }} />
              {confirmation === entry.id ? <>
                <CommunityButton label="确认删除" disabled={busy} onPress={() => remove(entry.id)} />
                <CommunityButton label="取消删除" disabled={busy} onPress={() => setConfirmation(undefined)} />
              </> : <CommunityButton label="删除" disabled={busy} onPress={() => setConfirmation(entry.id)} />}
            </View>
          </View>
        ))}
        {catalog && !draft && (
          <CommunityButton label={world ? "新增世界书条目" : "新增自定义技能"} disabled={busy || catalog.entries.length >= maxItems}
            onPress={() => { setConfirmation(undefined); setRefusal(undefined); setDraft({ ...emptyDraft }); }} />
        )}
        {draft && <View style={styles.entry}>
          <Text style={styles.meta}>{world ? "每行一个触发词（1–8 个）" : "名称最多 20 字"}</Text>
          <TextInput accessibilityLabel={world ? "触发词" : "技能名称"} style={styles.input}
            value={draft.label} multiline={world} editable={!busy} onChangeText={label => { setDraft({ ...draft, label }); setRefusal(undefined); }} />
          {refusal?.field === "label" && <Text accessibilityRole="alert" style={styles.error}>{refusal.text}</Text>}
          <Text style={styles.meta}>正文（最多 {bodyLimit} 字）</Text>
          <TextInput accessibilityLabel={world ? "世界书正文" : "技能正文"} style={[styles.input, styles.multiline]} multiline
            value={draft.body} editable={!busy} onChangeText={body => { setDraft({ ...draft, body }); setRefusal(undefined); }} />
          {refusal?.field === "body" && <Text accessibilityRole="alert" style={styles.error}>{refusal.text}</Text>}
          <View style={styles.heading}><Text style={styles.meta}>启用</Text>
            <Switch accessibilityLabel={world ? "启用世界书条目" : "启用自定义技能"} value={draft.enabled} disabled={busy}
              onValueChange={enabled => setDraft({ ...draft, enabled })} trackColor={{ true: ui.accent }} />
          </View>
          <View style={styles.actions}>
            <CommunityButton label="保存" primary disabled={!validDraft || busy} onPress={save} />
            <CommunityButton label="取消编辑" disabled={busy} onPress={() => { setDraft(undefined); setRefusal(undefined); }} />
          </View>
        </View>}
      </>}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  card: { padding: 14, gap: 8, borderWidth: 1, borderColor: ui.line, borderRadius: RADIUS.bubble, backgroundColor: ui.white },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 44, gap: 8 },
  title: { fontSize: 15, color: ui.ink, fontWeight: "600", flexShrink: 1 },
  meta: { fontSize: 13, color: ui.muted },
  error: { color: ui.danger, fontSize: 13 },
  entry: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: ui.line, paddingVertical: 8, gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: { padding: 8, minHeight: 44, color: ui.ink, borderColor: ui.line, borderWidth: 1, borderRadius: RADIUS.bubbleTail },
  multiline: { minHeight: 80, textAlignVertical: "top" },
});
