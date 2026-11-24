import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";

type Icon = React.ComponentProps<typeof Ionicons>["name"];

export function GlassCard({ children }: { children: React.ReactNode }) {
  const s = useThemedStyles(createStyles);
  return <LiquidGlassSurface glass borderRadius={24} style={s.card}>{children}</LiquidGlassSurface>;
}

export function GlassIcon({ label, icon, onPress, disabled }: { label: string; icon: Icon; onPress: () => void; disabled?: boolean }) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  return <LiquidGlassSurface glass borderRadius={22}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress} style={s.icon}>
      <Ionicons name={icon} size={23} color={ui.accentInk} />
    </Pressable>
  </LiquidGlassSurface>;
}

export function Choice({ title, description, note, icon, badge, selected, onPress }: {
  title: string; description: string; note: string; icon: Icon; badge?: string;
  selected?: boolean; onPress: () => void;
}) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const radio = selected !== undefined;
  return <LiquidGlassSurface glass borderRadius={24}>
    <Pressable accessibilityRole={radio ? "radio" : "button"} accessibilityState={radio ? { checked: selected } : undefined}
      onPress={onPress} style={({ pressed }) => [s.choice, selected && s.choiceSelected, pressed && s.pressed]}>
      <View style={s.choiceTop}>
        <View style={s.iconTile}><Ionicons name={icon} size={22} color={ui.accentInk} /></View>
        <Text style={[s.choiceTitle, s.flex]}>{title}</Text>
        {!!badge && <Text style={s.badge}>{badge}</Text>}
        <Ionicons name={radio ? (selected ? "radio-button-on" : "radio-button-off") : "chevron-forward"}
          size={19} color={ui.accentInk} />
      </View>
      <Text style={s.body}>{description}</Text>
      <Text style={s.note}>{note}</Text>
    </Pressable>
  </LiquidGlassSurface>;
}

export function BringField({ label, ...props }: TextInputProps & { label: string }) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  return <View style={s.field}>
    <Text style={s.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={ui.muted}
      {...props} style={[s.input, props.multiline && s.multiline, props.style]} />
  </View>;
}

export function BringButton({ label, onPress, secondary, disabled }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  const s = useThemedStyles(createStyles);
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, secondary ? s.buttonSecondary : s.buttonPrimary, disabled && s.disabled, pressed && s.pressed]}>
    <Text style={s.buttonLabel}>{label}</Text>
  </Pressable>;
}

export function Check({ label, checked, onPress, disabled }: {
  label: string; checked: boolean; onPress: () => void; disabled?: boolean;
}) {
  const s = useThemedStyles(createStyles);
  const { ui } = useSkin();
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} onPress={onPress}
    disabled={disabled} style={s.check}>
    <Ionicons name={checked ? "checkbox" : "square-outline"} size={22} color={ui.accentInk} />
    <Text style={[s.body, s.flex]}>{label}</Text>
  </Pressable>;
}

export function createStyles(ui: UiPalette) {
  return StyleSheet.create({
    flex: { flex: 1 },
    bar: { paddingHorizontal: 20, paddingTop: 8, flexDirection: "row", justifyContent: "space-between" },
    icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    page: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 30, gap: 14, flexGrow: 1, width: "100%", maxWidth: 560, alignSelf: "center" },
    heading: { gap: 8, marginBottom: 6 },
    title: { color: ui.ink, fontSize: 30, fontWeight: "700" },
    body: { color: ui.muted, fontSize: 14, lineHeight: 21 },
    hint: { color: ui.muted, alignSelf: "center", fontSize: 13, marginTop: "auto", paddingTop: 16 },
    replyOptions: { gap: 14 },
    progress: { flexDirection: "row", gap: 6, marginBottom: 2 },
    segment: { flex: 1, borderRadius: 4, height: 4, backgroundColor: ui.line },
    segmentCurrent: { backgroundColor: ui.accent },
    choice: { borderWidth: 1, borderColor: ui.highlight, borderRadius: 24, padding: 16, gap: 8 },
    choiceSelected: { borderColor: ui.accent, backgroundColor: ui.accentWash },
    choiceTop: { flexDirection: "row", alignItems: "center", gap: 10 },
    choiceTitle: { color: ui.ink, fontSize: 17, fontWeight: "700" },
    iconTile: { width: 38, height: 38, borderRadius: 14, backgroundColor: ui.accentWash, alignItems: "center", justifyContent: "center" },
    note: { color: ui.accentInk, fontSize: 12, lineHeight: 18 },
    badge: { backgroundColor: ui.iceBlue, color: ui.accentInk, overflow: "hidden", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, fontSize: 11 },
    card: { padding: 16, gap: 12 },
    field: { gap: 6 },
    label: { color: ui.ink, fontSize: 14, fontWeight: "600" },
    input: { minHeight: 46, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: ui.line, borderRadius: 14, backgroundColor: ui.white, color: ui.ink, fontSize: 15 },
    multiline: { minHeight: 74, textAlignVertical: "top" },
    button: { alignItems: "center", justifyContent: "center", minHeight: 50, borderRadius: 26, padding: 12, borderWidth: 1 },
    buttonPrimary: { backgroundColor: ui.iceBlue, borderColor: ui.accent },
    buttonSecondary: { backgroundColor: ui.white, borderColor: ui.line },
    buttonLabel: { fontSize: 15, fontWeight: "700", color: ui.accentInk },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.72 },
    check: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
    alert: { color: ui.accentInk, backgroundColor: ui.accentWash, borderRadius: 14, padding: 12, fontSize: 14, lineHeight: 21 },
    modal: { flex: 1, backgroundColor: "rgba(36,35,34,0.28)", justifyContent: "flex-end" },
    sheet: { maxHeight: "70%", padding: 20, paddingBottom: 34, gap: 12, backgroundColor: ui.background[0] },
    sheetTitle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    sheetHeading: { color: ui.ink, fontSize: 22, fontWeight: "700" },
    helpContent: { gap: 12 },
    helpItem: { gap: 4 },
  });
}
