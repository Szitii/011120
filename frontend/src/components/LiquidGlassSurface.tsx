import React from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import { PEARL_UI } from "../theme/skinTokens";

export function LiquidGlassSurface({
  glass = false,
  tint,
  borderRadius = RADIUS.pill,
  style,
  children,
}: {
  glass?: boolean;
  tint?: "light" | "dark";
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const { skin } = useSkin();
  const isDark = tint ? tint === "dark" : skin.isDark;

  return (
    <View pointerEvents={children ? "auto" : "none"} style={[
      { borderRadius },
      glass && styles.shadow,
      !glass && { backgroundColor: skin.colors.surface },
      style,
    ]}>
      <View pointerEvents="none" style={[
        StyleSheet.absoluteFill,
        styles.edge,
        { borderRadius, borderColor: glass ? (isDark ? skin.glass.border : PEARL_UI.highlight) : skin.colors.border },
      ]}>
        {glass && <>
          <BlurView
            intensity={isDark ? 48 : 52}
            tint={isDark ? "dark" : "light"}
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={isDark
              ? ["rgba(255,255,255,0.16)", "rgba(255,255,255,0.04)", "rgba(255,255,255,0.10)"]
              : PEARL_UI.sheen}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </>}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: PEARL_UI.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 2,
  },
  edge: { borderWidth: 1, overflow: "hidden" },
});
