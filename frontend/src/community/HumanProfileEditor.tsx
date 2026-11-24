import Ionicons from "@expo/vector-icons/Ionicons";
import { useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityClient, HumanProfileSettings } from "../../../contracts/community.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api.ts";
import { PixelAvatar } from "../components/PixelAvatar";
import { CommunityButton } from "./components.tsx";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

export function HumanProfileEditor({ client, viewer, onClose }: {
  client: CommunityClient;
  viewer: ActorContext;
  onClose: (saved: boolean) => void;
}) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const [settings, setSettings] = useState<HumanProfileSettings>();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [avatarNotice, setAvatarNotice] = useState("");
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
  const canSave = Boolean(
    settings && !loading && !saving && !conflict && nameLength > 0 && nameLength <= 80 && bioLength <= 500
      && (name !== settings.displayName || description !== settings.bio)
  );

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

  return (
    <ScrollView style={s.page} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
      <Text accessibilityRole="header" style={s.screenTitle}>编辑资料</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="更换头像"
        onPress={() => setAvatarNotice("自定义头像上传接口正在接入中，上线后点击这里即可从相册更换。")}
        style={({ pressed }) => [s.avatarBlock, pressed && { opacity: 0.85 }]}
      >
        <View style={s.avatarRing}>
          <PixelAvatar name={displayName || "我"} role="owner" size={88} />
          <View style={s.cameraBadge}>
            <Ionicons name="camera-outline" size={16} color={ui.onAccent} />
          </View>
        </View>
        <Text style={s.avatarHint}>轻点更换头像</Text>
      </Pressable>

      {!!avatarNotice && <Text style={s.infoText}>{avatarNotice}</Text>}
      {loading && <ActivityIndicator accessibilityLabel="正在加载资料" color={ui.accent} style={{ marginVertical: 16 }} />}

      {settings && (
        <View style={s.card}>
          <View style={s.fieldHeader}>
            <Text style={s.label}>社区昵称</Text>
            <Text style={nameLength > 80 ? s.errorText : s.counter}>{nameLength} / 80</Text>
          </View>
          <TextInput
            accessibilityLabel="社区昵称"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!loading && !saving}
            style={s.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="输入你的昵称"
            placeholderTextColor={ui.muted}
          />

          <View style={[s.fieldHeader, { marginTop: 8 }]}>
            <Text style={s.label}>简介</Text>
            <Text style={bioLength > 500 ? s.errorText : s.counter}>{bioLength} / 500</Text>
          </View>
          <TextInput
            accessibilityLabel="简介"
            editable={!loading && !saving}
            multiline
            style={[s.input, s.bioInput]}
            value={bio}
            onChangeText={setBio}
            placeholder="写一句介绍自己，对社区成员公开"
            placeholderTextColor={ui.muted}
          />
        </View>
      )}

      {error !== "" && <Text accessibilityRole="alert" style={s.errorText}>{error}</Text>}

      {settings && (
        <Pressable
          accessibilityRole="button"
          disabled={!canSave}
          onPress={() => void save()}
          style={({ pressed }) => [
            s.saveBtn,
            !canSave && s.saveBtnDisabled,
            pressed && canSave && { opacity: 0.86 },
          ]}
        >
          <Text style={s.saveBtnText}>{saving ? "正在保存…" : "保存资料"}</Text>
        </Pressable>
      )}

      {conflict && <CommunityButton label="载入最新资料" disabled={loading} onPress={() => void load()} />}
      {!settings && !loading && <CommunityButton label="重新加载" onPress={() => void load()} />}
    </ScrollView>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  page: { flex: 1 },
  content: {
    paddingHorizontal: CHROME.screenInset,
    paddingTop: 8,
    paddingBottom: CHROME.scrollBottomClearance + 24,
    gap: 16,
  },
  screenTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: ui.ink,
    textAlign: "center",
    marginBottom: 4,
  },
  avatarBlock: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  avatarRing: {
    position: "relative",
    padding: 4,
    borderRadius: 999,
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
  },
  cameraBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ui.accent,
    borderWidth: 2,
    borderColor: ui.white,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarHint: { fontSize: 12.5, color: ui.muted },
  infoText: { fontSize: 12.5, color: ui.accentInk, textAlign: "center" },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    padding: 18,
    gap: 10,
  },
  fieldHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: { fontSize: 14, fontWeight: "700", color: ui.ink },
  counter: { fontSize: 12, color: ui.muted },
  input: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14.5,
    color: ui.ink,
  },
  bioInput: {
    minHeight: 104,
    textAlignVertical: "top",
  },
  errorText: { fontSize: 12.5, color: ui.danger },
  saveBtn: {
    height: 50,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  saveBtnDisabled: {
    backgroundColor: ui.accentWash,
  },
  saveBtnText: { fontSize: 15.5, fontWeight: "700", color: ui.onAccent },
});
