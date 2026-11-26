import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { CommunityButton } from "../community/components";
import { BottomSheet } from "../components/BottomSheet";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { RADIUS } from "../theme/layoutTokens";
import { ApiProblemError } from "../adapters/real-api";
import type { ChatClient } from "../chat/client";
import type { Anniversary as RemoteAnniversary } from "../../../contracts/chat";
import { daysTogether, type Anniversary } from "./anniversary";
import { homeStorageKey, type HomeScope } from "./keys";

function parseDateParts(iso: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function formatIsoDate(year: number, month: number, day: number) {
  const maxDay = daysInMonth(year, month);
  const clamped = Math.max(1, Math.min(day, maxDay));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

export function AnniversaryPill({ scope, client, active }: { scope: HomeScope; client?: ChatClient; active: boolean }) {
  const { skin, ui } = useSkin();
  const st = useThemedStyles(createStyles);
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
    setReady(false);
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
        if (!value.startDate && value.revision === 1 && saved) {
          try {
            value = await client.saveAnniversary(scope.companionId, { ...saved, revision: value.revision });
          } catch (error) {
            if (!(error instanceof ApiProblemError) || error.status !== 409) throw error;
            value = await client.getAnniversary(scope.companionId);
          }
        }
        if (!current) return;
        // A cloud value, including a later explicit clear, is authoritative after migration.
        if (saved && (value.startDate || value.revision > 1)) void AsyncStorage.removeItem(key).catch(() => undefined);
        setRemote(value);
        setAnniversary(value.startDate ? { startDate: value.startDate, timeZone: value.timeZone } : undefined);
        setError("");
      } catch {
        if (current) {
          setRemote(undefined);
          if (saved) setAnniversary(saved);
          setError("暂时无法同步纪念日，请重新加载。");
        }
      } finally {
        if (current) setReady(true);
      }
    })();
    return () => { current = false; };
  }, [active, client, key, scope.companionId, reload]);

  function openSheet() {
    if (anniversary?.startDate) {
      setDraft(anniversary.startDate);
    } else {
      const now = new Date();
      setDraft(formatIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate()));
    }
    if (!usesCloud || remote) setError("");
    setOpen(true);
  }

  function stepDate(field: "year" | "month" | "day", delta: number) {
    const cur = parseDateParts(draft);
    let { year, month, day } = cur;
    if (field === "year") year = Math.max(1900, Math.min(new Date().getFullYear(), year + delta));
    if (field === "month") {
      month += delta;
      if (month > 12) month = 1;
      if (month < 1) month = 12;
    }
    if (field === "day") {
      const maxD = daysInMonth(year, month);
      day += delta;
      if (day > maxD) day = 1;
      if (day < 1) day = maxD;
    }
    setDraft(formatIsoDate(year, month, day));
    setError("");
  }

  async function save(clear = false) {
    if (!ready || pending.current || (usesCloud && !remote)) return;
    const next = {
      startDate: draft.trim(),
      timeZone: anniversary?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (!clear && daysTogether(next) === undefined) {
      setError("请选择今天或更早的日期。");
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

  const days = anniversary && daysTogether(anniversary);
  const label = !ready ? "纪念日" : days ? `在一起的第 ${days} 天 · 纪念日` : "设置我们的纪念日";
  const previewDays = daysTogether({
    startDate: draft,
    timeZone: anniversary?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const nextMilestone = previewDays === undefined ? undefined : (Math.floor(previewDays / 100) + 1) * 100;
  const parts = parseDateParts(draft);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={!ready}
        onPress={openSheet}
        style={({ pressed }) => [st.pill, { borderColor: skin.colors.border }, pressed && { opacity: 0.78 }]}
      >
        <LiquidGlassSurface glass borderRadius={RADIUS.pill} style={StyleSheet.absoluteFill} />
        <Ionicons name="calendar-outline" size={14} color={ui.accentInk} />
        <Text style={st.pillText}>{label}</Text>
        <Ionicons name="chevron-forward" size={14} color={ui.muted} />
      </Pressable>

      <BottomSheet visible={open} title="纪念日" onClose={() => { if (!saving) setOpen(false); }}>
        <ScrollView contentContainerStyle={st.sheetBody} keyboardShouldPersistTaps="handled">
          <View style={st.heroCard}>
            <Text style={st.heroEyebrow}>我们的纪念日</Text>
            <View style={st.heroNumberRow}>
              <Text style={st.heroNumber}>{previewDays ?? "—"}</Text>
              <Text style={st.heroUnit}>天</Text>
            </View>
            <Text style={st.heroSub}>
              始于 {parts.year} 年 {parts.month} 月 {parts.day} 日
            </Text>
            {previewDays !== undefined && nextMilestone !== undefined && (
              <Text style={st.heroSub}>距离 {nextMilestone} 天还有 {nextMilestone - previewDays} 天</Text>
            )}
          </View>

          <View style={st.formCard}>
            <Text style={st.fieldLabel}>开始日期</Text>
            <View style={st.wheelRow}>
              {[
                { key: "year" as const, label: "年份", value: `${parts.year} 年` },
                { key: "month" as const, label: "月份", value: `${parts.month} 月` },
                { key: "day" as const, label: "日期", value: `${parts.day} 日` },
              ].map(col => (
                <View key={col.key} style={st.wheelCol}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`增加${col.label}`}
                    disabled={saving}
                    onPress={() => stepDate(col.key, 1)}
                    style={st.stepBtn}
                  >
                    <Ionicons name="chevron-up" size={18} color={ui.accentInk} />
                  </Pressable>
                  <View style={st.wheelValBox}>
                    <Text style={st.wheelValText}>{col.value}</Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`减少${col.label}`}
                    disabled={saving}
                    onPress={() => stepDate(col.key, -1)}
                    style={st.stepBtn}
                  >
                    <Ionicons name="chevron-down" size={18} color={ui.accentInk} />
                  </Pressable>
                </View>
              ))}
            </View>
          </View>

          {(error || previewDays === undefined) && <Text accessibilityRole="alert" style={st.errorText}>
            {error || "请选择今天或更早的日期。"}
          </Text>}

          <CommunityButton primary label={saving ? "保存中…" : "保存纪念日"}
            disabled={!ready || saving || previewDays === undefined || (usesCloud && !remote)} onPress={() => void save()} />
          {anniversary && <CommunityButton label="清除纪念日"
            disabled={!ready || saving || (usesCloud && !remote)} onPress={() => void save(true)} />}
          {usesCloud && ready && !remote && <CommunityButton label="重新加载" onPress={() => setReload(value => value + 1)} />}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    overflow: "hidden",
  },
  pillText: { fontSize: 13.5, fontWeight: "600", color: ui.ink },
  sheetBody: { gap: 14, paddingBottom: 12 },
  heroCard: {
    borderRadius: 20,
    backgroundColor: ui.accentWash,
    borderWidth: 1,
    borderColor: ui.highlight,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 4,
  },
  heroEyebrow: { fontSize: 13.5, fontWeight: "600", color: ui.accentInk },
  heroNumberRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  heroNumber: { fontSize: 40, fontWeight: "800", color: ui.accent, letterSpacing: -0.5 },
  heroUnit: { fontSize: 15, fontWeight: "700", color: ui.accentInk },
  heroSub: { fontSize: 12, color: ui.muted, marginTop: 2 },
  formCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    padding: 16,
    gap: 10,
  },
  fieldLabel: { fontSize: 13.5, fontWeight: "700", color: ui.ink },
  wheelRow: {
    flexDirection: "row",
    gap: 8,
  },
  wheelCol: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  stepBtn: {
    width: "100%",
    height: 32,
    borderRadius: 10,
    backgroundColor: ui.background[0],
    alignItems: "center",
    justifyContent: "center",
  },
  wheelValBox: {
    width: "100%",
    height: 40,
    borderRadius: 12,
    backgroundColor: ui.accentWash,
    alignItems: "center",
    justifyContent: "center",
  },
  wheelValText: { fontSize: 15, fontWeight: "700", color: ui.ink },
  errorText: { fontSize: 12.5, color: ui.danger, textAlign: "center" },
});
