import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { useSkin } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { PEARL_UI } from "../theme/skinTokens";
import { ROOT_TABS, type RootTab } from "../state/navigation";

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
    pulse.setValue(0.92);
    Animated.spring(pulse, {
      toValue: 1,
      speed: 22,
      bounciness: 8,
      useNativeDriver: true,
    }).start();
  }, [current, pulse]);

  const items: Record<RootTab, {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    activeIcon: keyof typeof Ionicons.glyphMap;
  }> = {
    world: { label: "社区", icon: "people-outline", activeIcon: "people" },
    home: { label: "小家", icon: "home-outline", activeIcon: "home" },
    messages: { label: "消息", icon: "chatbubbles-outline", activeIcon: "chatbubbles" },
    my: { label: "我的", icon: "person-outline", activeIcon: "person" },
  };

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
          {ROOT_TABS.map((key) => {
            const item = items[key];
            const active = current === key;
            const color = skin.id === "default"
              ? (active ? PEARL_UI.accentInk : "#5E5A56")
              : (active ? skin.colors.tabActive : skin.colors.tabInactive);
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                onPress={() => onSelect(key)}
                style={({ pressed }) => [
                  styles.tab,
                  active && styles.activeLens,
                  active && skin.id !== "default" && {
                    backgroundColor: skin.glass.activePillFill,
                    borderColor: skin.glass.border,
                  },
                  pressed && { transform: [{ scale: 0.94 }] },
                ]}
              >
                <Animated.View style={[styles.tabInner, active && { transform: [{ scale: pulse }] }]}>
                  <Ionicons name={active ? item.activeIcon : item.icon} size={18} color={color} />
                  <Text style={[styles.label, { color, fontWeight: active ? "700" : "500" }]}>
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
  row: { flexDirection: "row", alignItems: "center", padding: 5, gap: 5 },
  tab: {
    flex: 1,
    minHeight: 50,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  activeLens: {
    backgroundColor: "rgba(180, 192, 212, 0.46)",
    borderColor: "rgba(255, 255, 255, 0.90)",
    borderWidth: 1,
    shadowColor: "#7B90AC",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 8,
    elevation: 2,
  },
  tabInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 10.5, marginTop: 2 },
});
