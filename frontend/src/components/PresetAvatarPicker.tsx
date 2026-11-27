import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { safeClientMessage } from "../adapters/real-api";
import { CommunityButton, SecondaryHeading, useCommunityStyles } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import { AvatarPreviewError, prepareAvatarPreview, type AvatarPreview } from "./avatar-preview";
import { avatarPresets, PixelAvatar } from "./PixelAvatar";

const PREVIEW_AVATAR_SIZE = 64;
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
  const [preview, setPreview] = useState<AvatarPreview>();
  const [picking, setPicking] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const busy = saving || picking;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => () => preview?.release(), [preview]);

  async function pickPhoto() {
    if (pending.current) return;
    pending.current = true;
    setPicking(true);
    setError("");
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: Platform.OS !== "web",
        aspect: [1, 1],
        quality: 1,
      });
      if (result.canceled) return;
      const photo = await prepareAvatarPreview(result.assets[0]);
      if (mounted.current) setPreview(photo);
      else photo.release();
    } catch (error) {
      if (!mounted.current) return;
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (error instanceof AvatarPreviewError) {
        setError(error.message);
      } else if (error instanceof Error && /permission|access denied|notallowed/i.test(`${code} ${error.name} ${error.message}`)) {
        setError("无法访问相册。请在系统设置里允许照片访问，再试一次。");
      } else {
        setError("无法打开或处理这张照片，请重新选择 JPG、PNG 或 WebP。");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setPicking(false);
    }
  }

  async function save() {
    if (pending.current || preview || selection === (current ?? null)) return;
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
    <View style={s.card}>
      <View style={s.actorRow}>
        <PixelAvatar name={preview ? "本机照片预览" : "头像预览"} role={role}
          uri={preview?.uri ?? selection} size={PREVIEW_AVATAR_SIZE} />
        <View style={s.actorTextWrap}>
          <Text style={s.author}>{preview ? "本机照片预览" : "头像预览"}</Text>
          <Text accessibilityLiveRegion="polite" style={s.meta}>
            {picking ? "正在选取或处理照片…" : "自定义照片暂不可上传，仅在此页预览。"}
          </Text>
        </View>
      </View>
      <View style={s.row}>
        <CommunityButton label={preview ? "重新选照片" : "从相册选取"} disabled={busy}
          onPress={() => void pickPhoto()} />
        {preview && <CommunityButton label="取消预览" disabled={busy}
          onPress={() => { setPreview(undefined); setError(""); }} />}
      </View>
    </View>
    <View accessibilityRole="radiogroup" style={[s.row, s.card]}>
      {options.map(option => (
        <Pressable key={option.value ?? "default"} accessibilityRole="radio" accessibilityLabel={option.label}
          accessibilityState={{ checked: !preview && option.value === selection, disabled: busy }} disabled={busy}
          style={{ alignItems: "center", gap: 6, padding: 8, borderRadius: 14, backgroundColor: !preview && selection === option.value ? ui.accentWash : ui.white }}
          onPress={() => { setPreview(undefined); setSelection(option.value); setError(""); }}>
          <PixelAvatar name={option.label} role={role} uri={option.value} size={52} />
          <Text style={s.meta}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
    {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <CommunityButton primary label={saving ? "正在保存…" : "保存头像"} disabled={busy || !!preview || selection === (current ?? null)}
      onPress={() => void save()} />
  </ScrollView>;
}
