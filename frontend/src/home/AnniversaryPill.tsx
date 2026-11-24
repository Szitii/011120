import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { BottomSheet } from "../components/BottomSheet";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { CommunityButton, useCommunityStyles } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import { ApiProblemError } from "../adapters/real-api";
import type { ChatClient } from "../chat/client";
import type { Anniversary as RemoteAnniversary } from "../../../contracts/chat";
import { daysTogether, type Anniversary } from "./anniversary";
import { homeStorageKey, type HomeScope } from "./keys";

export function AnniversaryPill({ scope, client, active }: { scope: HomeScope; client?: ChatClient; active: boolean }) {
  const s = useCommunityStyles();
  const { skin } = useSkin();
  const key = homeStorageKey(scope, "anniversary");
  const [anniversary, setAnniversary] = useState<Anniversary>();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<RemoteAnniversary>();
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const usesCloud = Boolean(client?.getAnniversary && client.saveAnniversary);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      let saved: Anniversary | undefined;
      try {
        const raw = await AsyncStorage.getItem(key).catch(() => null);
        if (!current) return;
        if (raw) {
          try {
            const value: Anniversary = JSON.parse(raw);
            if (value && typeof value.startDate === "string" && typeof value.timeZone === "string" && daysTogether(value)) saved = value;
          } catch { /* A corrupt legacy date should not block cloud loading. */ }
        }
        if (!client?.getAnniversary || !client.saveAnniversary) {
          setAnniversary(saved);
          return;
        }
        let value = await client.getAnniversary(scope.companionId);
        if (!current) return;
        if (!value.startDate && saved) {
          try {
            value = await client.saveAnniversary(scope.companionId, { ...saved, revision: value.revision });
          } catch (error) {
            if (!(error instanceof ApiProblemError) || error.status !== 409) throw error;
            value = await client.getAnniversary(scope.companionId);
          }
        }
        if (!current) return;
        // A cloud value, including a later explicit clear, is authoritative after migration.
        if (saved && value.startDate) void AsyncStorage.removeItem(key).catch(() => undefined);
        setRemote(value);
        setAnniversary(value.startDate ? { startDate: value.startDate, timeZone: value.timeZone } : undefined);
        setError("");
      } catch {
        if (current) {
          if (saved) setAnniversary(saved);
          setError("暂时无法同步纪念日，请重新加载。");
        }
      } finally {
        if (current) setReady(true);
      }
    })();
    return () => { current = false; };
  }, [active, client, key, scope.companionId, reload]);

  const days = anniversary && daysTogether(anniversary);
  const label = days ? `在一起的第 ${days} 天 · 纪念日` : "设置纪念日";

  async function save(clear = false) {
    if (pending.current || (usesCloud && !remote)) return;
    const next = {
      startDate: draft.trim(),
      timeZone: anniversary?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (!clear && daysTogether(next) === undefined) {
      setError("请输入有效日期，格式为 YYYY-MM-DD，日期不能晚于今天。");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      if (client?.saveAnniversary && remote) {
        const value = await client.saveAnniversary(scope.companionId, { ...next, startDate: clear ? null : next.startDate, revision: remote.revision });
        setRemote(value);
        await AsyncStorage.removeItem(key).catch(() => undefined);
        setAnniversary(value.startDate ? { startDate: value.startDate, timeZone: value.timeZone } : undefined);
      } else {
        if (clear) await AsyncStorage.removeItem(key);
        else await AsyncStorage.setItem(key, JSON.stringify(next));
        setAnniversary(clear ? undefined : next);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof ApiProblemError && error.status === 409 && client?.getAnniversary) {
        try {
          const latest = await client.getAnniversary(scope.companionId);
          setRemote(latest);
          setAnniversary(latest.startDate ? { startDate: latest.startDate, timeZone: latest.timeZone } : undefined);
          setDraft(latest.startDate ?? "");
          setError("另一台设备已更新，请确认日期后再保存。");
        } catch {
          setRemote(undefined);
          setError("无法读取最新日期，请重新加载。");
        }
      } else setError("日期没保存成功，请再试一次。");
    } finally {
      pending.current = false;
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
        <Text style={s.meta}>{usesCloud ? "填写你们开始相伴的日子，日期会同步到其他设备。" : "填写你们开始相伴的日子。日期保存在当前设备。"}</Text>
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
        <CommunityButton label="保存纪念日" primary disabled={saving || (usesCloud && !remote)} onPress={() => void save()} />
        {anniversary && <CommunityButton label="清除纪念日" disabled={saving || (usesCloud && !remote)} onPress={() => void save(true)} />}
        {usesCloud && !remote && <CommunityButton label="重新加载" onPress={() => setReload(value => value + 1)} />}
      </View>
    </BottomSheet>
  </>;
}

const styles = StyleSheet.create({
  pill: { minHeight: 44, paddingHorizontal: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  form: { gap: 10 },
});
