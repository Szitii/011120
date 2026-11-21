import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityClient, HumanProfileSettings } from "../../../../packages/community-contracts/types.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api.ts";
import { CommunityButton, communityStyles as s } from "./components.tsx";

export function HumanProfileEditor({ client, viewer, onClose }: {
  client: CommunityClient;
  viewer: ActorContext;
  onClose: (saved: boolean) => void;
}) {
  const [settings, setSettings] = useState<HumanProfileSettings>();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const requestPending = useRef(false);
  const ownerId = viewer.id;
  const viewerKind = viewer.kind;

  async function load() {
    if (requestPending.current) return;
    requestPending.current = true;
    setLoading(true);
    setError("");
    try {
      const current = await client.humanProfileSettings({ kind: viewerKind, id: ownerId });
      if (!active.current) return;
      setSettings(current);
      setDisplayName(current.displayName);
      setBio(current.bio);
      setConflict(false);
    } catch (err) {
      if (active.current) setError(safeClientMessage(err).title);
    } finally {
      requestPending.current = false;
      if (active.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; };
  }, [client, ownerId, viewerKind]);

  const name = displayName.trim();
  const description = bio.trim();
  const nameLength = Array.from(name).length;
  const bioLength = Array.from(description).length;
  const canSave = settings && !loading && !saving && !conflict && nameLength > 0 && nameLength <= 80 && bioLength <= 500
    && (name !== settings.displayName || description !== settings.bio);

  async function save() {
    if (!settings || !canSave || requestPending.current) return;
    requestPending.current = true;
    setSaving(true);
    setError("");
    try {
      await client.saveHumanProfile(viewer, { displayName: name, bio: description, revision: settings.revision });
      if (active.current) onClose(true);
    } catch (err) {
      if (!active.current) return;
      if (err instanceof ApiProblemError && err.status === 409) {
        setConflict(true);
        setError("资料已在其他地方更新。载入最新版本后再编辑。");
      } else if (err instanceof ApiProblemError && err.status === 400) {
        setError("请检查昵称和简介，昵称中不能有换行。");
      } else {
        setError(safeClientMessage(err).title);
      }
    } finally {
      requestPending.current = false;
      if (active.current) setSaving(false);
    }
  }

  return <ScrollView style={s.page} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.title}>编辑社区资料</Text>
    {loading && <ActivityIndicator accessibilityLabel="正在加载资料" color="#9C6D79" />}
    {settings && <View style={s.card}>
      <Text style={s.author}>社区昵称</Text>
      <TextInput accessibilityLabel="社区昵称" autoCapitalize="none" autoCorrect={false}
        editable={!loading && !saving} style={styles.name} value={displayName} onChangeText={setDisplayName} />
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

const styles = StyleSheet.create({ name: { ...s.input, minHeight: 48, textAlignVertical: "center" } });
