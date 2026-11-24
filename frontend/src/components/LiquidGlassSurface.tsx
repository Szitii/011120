import React from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";

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
  const { skin, ui } = useSkin();
  const isDark = tint ? tint === "dark" : skin.isDark;

  return (
    <View
      pointerEvents={children ? "auto" : "none"}
      style={[
        { borderRadius },
        glass && [styles.shadow, { shadowColor: ui.shadow }],
        !glass && { backgroundColor: ui.white },
        style,
      ]}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.edge,
          {
            borderRadius,
            borderColor: glass
              ? (isDark === skin.isDark ? skin.glass.border : isDark ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.90)")
              : ui.line,
          },
        ]}
      >
        {glass && (
          <>
            <BlurView
              intensity={isDark ? 42 : 46}
              tint={isDark ? "dark" : "light"}
              experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient
              colors={
                isDark
                  ? ["rgba(255,255,255,0.16)", "rgba(255,255,255,0.04)", "rgba(255,255,255,0.10)"]
                  : ["rgba(255,255,255,0.44)", "rgba(255,255,255,0.16)", "rgba(255,255,255,0.34)"]
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </>
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.13,
    shadowRadius: 15,
    elevation: 3,
  },
  edge: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
