import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { BottomSheet } from "../components/BottomSheet";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { CommunityButton, communityStyles as s } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import { daysTogether, type Anniversary } from "./anniversary";
import { homeStorageKey, type HomeScope } from "./keys";

export function AnniversaryPill({ scope }: { scope: HomeScope }) {
  const { skin } = useSkin();
  const key = homeStorageKey(scope, "anniversary");
  const [anniversary, setAnniversary] = useState<Anniversary>();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(key).then(raw => {
      if (!active || !raw) return;
      const saved: Anniversary = JSON.parse(raw);
      if (saved && typeof saved.startDate === "string" && typeof saved.timeZone === "string") setAnniversary(saved);
    }).catch(() => {
      if (active) setError("暂时读不到已保存的日期。");
    }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [key]);

  const days = anniversary && daysTogether(anniversary);
  const label = days ? `在一起的第 ${days} 天 · 纪念日` : "设置纪念日";

  async function save() {
    if (saving) return;
    const next = {
      startDate: draft.trim(),
      timeZone: anniversary?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (daysTogether(next) === undefined) {
      setError("请输入有效日期，格式为 YYYY-MM-DD，日期不能晚于今天。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await AsyncStorage.setItem(key, JSON.stringify(next));
      setAnniversary(next);
      setOpen(false);
    } catch {
      setError("日期没保存成功，请再试一次。");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!ready} onPress={() => {
      setDraft(anniversary?.startDate ?? "");
      setOpen(true);
    }}>
      <LiquidGlassSurface glass borderRadius={RADIUS.pill}>
        <View style={styles.pill}>
          <Ionicons name="calendar-outline" size={17} color={skin.colors.tabActive} />
          <Text style={[s.body, { color: skin.colors.ink, flexShrink: 1 }]}>
            {label}
          </Text>
          <Ionicons name="chevron-forward" size={15} color={skin.colors.inkSub} />
        </View>
      </LiquidGlassSurface>
    </Pressable>
    <BottomSheet visible={open} title="纪念日" onClose={() => { if (!saving) setOpen(false); }}>
      <View style={styles.form}>
        <Text style={s.meta}>填写你们开始相伴的日子。日期保存在当前设备。</Text>
        <TextInput
          accessibilityLabel="相伴起始日期"
          value={draft}
          onChangeText={setDraft}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          editable={!saving}
          maxLength={10}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          style={s.input}
        />
        {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
        <CommunityButton label="保存纪念日" primary disabled={saving} onPress={() => void save()} />
      </View>
    </BottomSheet>
  </>;
}

const styles = StyleSheet.create({
  pill: { minHeight: 44, paddingHorizontal: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  form: { gap: 10 },
});
