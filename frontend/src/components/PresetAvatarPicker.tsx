import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import { avatarPresets, PixelAvatar } from "./PixelAvatar";

const options = [{ value: null, label: "默认头像" }, ...avatarPresets];

export function PresetAvatarPicker({ current, name, role, onSave, onClose }: {
  current?: string | null;
  name: string;
  role: "owner" | "companion";
  onSave: (value: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { ui } = useSkin();
  const s = useCommunityStyles();
  const [selection, setSelection] = useState(current ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function save() {
    if (pending.current || selection === (current ?? null)) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(selection);
      onClose();
    } catch (error) {
      setError(`头像未保存。${safeClientMessage(error).title}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <ScrollView style={s.page} contentContainerStyle={s.content}>
    <SecondaryHeading title={role === "owner" ? "更换我的头像" : `更换 ${name} 的头像`} />
    <View accessibilityRole="radiogroup" style={[s.row, s.card]}>
      {options.map(option => (
        <Pressable key={option.value ?? "default"} accessibilityRole="radio" accessibilityLabel={option.label}
          accessibilityState={{ checked: option.value === selection, disabled: saving }} disabled={saving}
          style={{ alignItems: "center", gap: 6, padding: 8, borderRadius: 14, backgroundColor: selection === option.value ? ui.accentWash : ui.white }}
          onPress={() => { setSelection(option.value); setError(""); }}>
          <PixelAvatar name={option.label} role={role} uri={option.value} size={52} />
          <Text style={s.meta}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
    {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <CommunityButton primary label={saving ? "正在保存…" : "保存头像"} disabled={saving || selection === (current ?? null)}
      onPress={() => void save()} />
  </ScrollView>;
}
