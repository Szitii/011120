import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LiquidGlassSurface } from "./LiquidGlassSurface";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { ROOT_TABS, type RootTab } from "../state/navigation";

export function FloatingGlassTabs({
  current,
  onSelect,
  unread = 0,
}: {
  current: RootTab;
  unread?: number;
  onSelect: (tab: RootTab) => void;
}) {
  const { skin } = useSkin();
  const styles = useThemedStyles(createStyles);
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
            const color = active ? skin.colors.tabActive : skin.colors.tabInactive;
            const count = key === "messages" ? unread : 0;
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityHint={count ? `${count} 条未读` : undefined}
                accessibilityState={{ selected: active }}
                onPress={() => onSelect(key)}
                style={({ pressed }) => [
                  styles.tab,
                  active && styles.activeLens,
                  active && {
                    backgroundColor: skin.glass.activePillFill,
                    borderColor: skin.glass.border,
                    shadowColor: skin.colors.accent,
                  },
                  pressed && { transform: [{ scale: 0.94 }] },
                ]}
              >
                <Animated.View style={[styles.tabInner, active && { transform: [{ scale: pulse }] }]}>
                  <Ionicons name={active ? item.activeIcon : item.icon} size={18} color={color} />
                  {count > 0 && <Text style={styles.badge}>{count > 99 ? "99+" : count}</Text>}
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

const createStyles = () => StyleSheet.create({
  badge: { position: "absolute", top: -3, right: -13, color: "#FFFFFF", backgroundColor: "#495C76",
    borderRadius: 10, overflow: "hidden", paddingHorizontal: 5, fontSize: 10, fontWeight: "700" },
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
    borderWidth: 1,
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
