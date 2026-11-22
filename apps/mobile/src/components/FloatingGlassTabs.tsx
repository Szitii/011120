import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { useSkin } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import type { RootTab } from "../state/navigation";

export function FloatingGlassTabs({
  current,
  isSampleCompanion,
  onSelect,
}: {
  current: RootTab;
  isSampleCompanion: boolean;
  onSelect: (tab: RootTab) => void;
}) {
  const { skin } = useSkin();
  const inactiveColor = skin.isDark ? "#94A3B8" : "#64748B";
  const items: Array<{
    key: RootTab;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    activeIcon: keyof typeof Ionicons.glyphMap;
  }> = [
    { key: "world", label: "公共社区", icon: "compass-outline", activeIcon: "compass" },
    { key: "home", label: "私人小家", icon: "home-outline", activeIcon: "home" },
    {
      key: "my",
      label: "我的",
      icon: isSampleCompanion ? "sparkles-outline" : "person-outline",
      activeIcon: isSampleCompanion ? "sparkles" : "person",
    },
  ];

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        {
          left: 24,
          right: 24,
          bottom: CHROME.floatingDockBottom,
        },
      ]}
    >
      <LiquidGlassSurface variant="dock" borderRadius={RADIUS.pill}>
        <View style={styles.row}>
          {items.map((item) => {
            const active = current === item.key;
            const color = active ? skin.colors.tabActive : inactiveColor;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => onSelect(item.key)}
                style={({ pressed }) => [
                  styles.tab,
                  active && {
                    backgroundColor: skin.glass.activePillFill,
                    borderColor: skin.glass.border,
                    borderWidth: 1,
                  },
                  pressed && { transform: [{ scale: 0.94 }] },
                ]}
              >
                <Ionicons name={active ? item.activeIcon : item.icon} size={18} color={color} />
                <Text style={[styles.label, { color, fontWeight: active ? "600" : "500" }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </LiquidGlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: "absolute", zIndex: 30 },
  row: { flexDirection: "row", alignItems: "center", padding: 4, gap: 4 },
  tab: {
    flex: 1,
    height: 46,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 10, marginTop: 1.5 },
});
