import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { useSkin } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { PEARL_UI } from "../theme/skinTokens";
import type { RootTab } from "../state/navigation";

export function FloatingGlassTabs({
  current,
  onSelect,
}: {
  current: RootTab;
  onSelect: (tab: RootTab) => void;
}) {
  const { skin } = useSkin();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    pulse.setValue(0.94);
    Animated.spring(pulse, {
      toValue: 1,
      speed: 24,
      bounciness: 8,
      useNativeDriver: true,
    }).start();
  }, [current, pulse]);

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
      icon: "person-outline",
      activeIcon: "person",
    },
  ];

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        {
          left: CHROME.screenInset,
          right: CHROME.screenInset,
          bottom: CHROME.floatingDockBottom,
        },
      ]}
    >
      <LiquidGlassSurface glass>
        <View style={styles.row}>
          {items.map((item) => {
            const active = current === item.key;
            const color = skin.id === "default"
              ? (active ? PEARL_UI.accentInk : PEARL_UI.muted)
              : (active ? skin.colors.tabActive : skin.colors.tabInactive);
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
                <Animated.View style={[styles.tabInner, active && { transform: [{ scale: pulse }] }]}>
                  <Ionicons name={active ? item.activeIcon : item.icon} size={18} color={color} />
                  <Text style={[styles.label, { color, fontWeight: active ? "600" : "500" }]}>
                    {item.label}
                  </Text>
                </Animated.View>
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
    minHeight: 48,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  tabInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 10, marginTop: 1.5 },
});
