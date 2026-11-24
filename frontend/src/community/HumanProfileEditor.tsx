import { useSkin } from "../theme/SkinProvider";
import { useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityClient, HumanProfileSettings } from "../../../contracts/community.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api.ts";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "./components.tsx";

export function HumanProfileEditor({ client, viewer, onClose }: {
  client: CommunityClient;
  viewer: ActorContext;
  onClose: (saved: boolean) => void;
}) {
  const s = useCommunityStyles();
  const { ui } = useSkin();
  const [settings, setSettings] = useState<HumanProfileSettings>();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const ownerId = viewer.id;
  const viewerKind = viewer.kind;
  const scope = useMemo(() => ({ active: false, pending: false, version: 0 }), [client, ownerId, viewerKind]);

  async function load() {
    if (scope.pending) return;
    scope.pending = true;
    const version = scope.version;
    setLoading(true);
    setError("");
    try {
      const current = await client.humanProfileSettings({ kind: viewerKind, id: ownerId });
      if (!scope.active || scope.version !== version) return;
      setSettings(current);
      setDisplayName(current.displayName);
      setBio(current.bio);
      setConflict(false);
    } catch (err) {
      if (scope.active && scope.version === version) setError(safeClientMessage(err).title);
    } finally {
      if (scope.active && scope.version === version) {
        scope.pending = false;
        setLoading(false);
      }
    }
  }

  useLayoutEffect(() => {
    scope.active = true;
    scope.pending = false;
    setSettings(undefined);
    setDisplayName("");
    setBio("");
    setSaving(false);
    setConflict(false);
    void load();
    return () => { scope.active = false; scope.version++; };
  }, [scope]);

  const name = displayName.trim();
  const description = bio.trim();
  const nameLength = Array.from(name).length;
  const bioLength = Array.from(description).length;
  const canSave = settings && !loading && !saving && !conflict && nameLength > 0 && nameLength <= 80 && bioLength <= 500
    && (name !== settings.displayName || description !== settings.bio);

  async function save() {
    if (!settings || !canSave || scope.pending) return;
    scope.pending = true;
    const version = scope.version;
    setSaving(true);
    setError("");
    try {
      await client.saveHumanProfile(viewer, { displayName: name, bio: description, revision: settings.revision });
      if (scope.active && scope.version === version) onClose(true);
    } catch (err) {
      if (!scope.active || scope.version !== version) return;
      if (err instanceof ApiProblemError && err.status === 409) {
        setConflict(true);
        setError("资料已在其他地方更新。载入最新版本后再编辑。");
      } else if (err instanceof ApiProblemError && err.status === 400) {
        setError("请检查昵称和简介，昵称中不能有换行。");
      } else {
        setError(safeClientMessage(err).title);
      }
    } finally {
      if (scope.active && scope.version === version) {
        scope.pending = false;
        setSaving(false);
      }
    }
  }

  return <ScrollView style={s.page} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
    <SecondaryHeading title="编辑资料" />
    {loading && <ActivityIndicator accessibilityLabel="正在加载资料" color={ui.accent} />}
    {settings && <View style={s.card}>
      <Text style={s.author}>社区昵称</Text>
      <TextInput accessibilityLabel="社区昵称" autoCapitalize="none" autoCorrect={false}
        editable={!loading && !saving} style={[s.input, { minHeight: 48, textAlignVertical: "center" }]} value={displayName} onChangeText={setDisplayName} />
      <Text style={nameLength > 80 ? s.error : s.meta}>{nameLength} / 80</Text>
      <Text style={s.author}>简介</Text>
      <TextInput accessibilityLabel="简介" editable={!loading && !saving} multiline style={s.input} value={bio} onChangeText={setBio} />
      <Text style={bioLength > 500 ? s.error : s.meta}>{bioLength} / 500 · 对社区成员公开</Text>
    </View>}
    {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <View style={s.row}>
      <CommunityButton label="取消" disabled={saving} onPress={() => onClose(false)} />
      {settings && <CommunityButton label={saving ? "正在保存…" : "保存资料"} selected disabled={!canSave} onPress={() => void save()} />}
      {conflict && <CommunityButton label="载入最新资料" disabled={loading} onPress={() => void load()} />}
      {!settings && !loading && <CommunityButton label="重新加载" onPress={() => void load()} />}
    </View>
  </ScrollView>;
}
