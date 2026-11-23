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
  const { skin } = useSkin();
  const isDark = tint ? tint === "dark" : skin.isDark;

  return (
    <View
      pointerEvents={children ? "auto" : "none"}
      style={[
        { borderRadius },
        glass && styles.shadow,
        !glass && { backgroundColor: skin.colors.surface },
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
              ? isDark
                ? "rgba(255, 255, 255, 0.24)"
                : "rgba(255, 255, 255, 0.92)"
              : skin.colors.border,
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
            {/* Crisp top specular rim + soft bottom edge for real glass depth */}
            <View
              style={[
                styles.topSpecular,
                {
                  backgroundColor: isDark
                    ? "rgba(255, 255, 255, 0.28)"
                    : "rgba(255, 255, 255, 0.95)",
                },
              ]}
            />
            <View
              style={[
                styles.bottomRim,
                {
                  backgroundColor: isDark
                    ? "rgba(0, 0, 0, 0.24)"
                    : "rgba(123, 144, 172, 0.16)",
                },
              ]}
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
    shadowColor: "#6B645A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.13,
    shadowRadius: 15,
    elevation: 3,
  },
  edge: {
    borderWidth: 1.15,
    overflow: "hidden",
  },
  topSpecular: {
    position: "absolute",
    top: 0,
    left: 14,
    right: 14,
    height: 1,
    borderRadius: 1,
  },
  bottomRim: {
    position: "absolute",
    bottom: 0,
    left: 14,
    right: 14,
    height: 1,
    borderRadius: 1,
  },
});
