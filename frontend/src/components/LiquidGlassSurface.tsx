import React from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";

export function LiquidGlassSurface({
  borderRadius = RADIUS.pill,
  style,
  children,
}: {
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { skin } = useSkin();
  const isDark = skin.isDark;

  const sheenColors: [string, string, string] = isDark
    ? ["rgba(255,255,255,0.16)", "rgba(255,255,255,0.04)", "rgba(255,255,255,0.10)"]
    : ["rgba(255,255,255,0.74)", "rgba(255,255,255,0.32)", "rgba(255,255,255,0.60)"];

  return (
    <View
      style={[
        styles.outer,
        {
          borderRadius,
          borderColor: skin.glass.outerRing,
        },
        style,
      ]}
    >
      <View
        style={[
          styles.inner,
          {
            borderRadius,
            borderColor: skin.glass.border,
          },
        ]}
      >
        <BlurView
          intensity={isDark ? 58 : 72}
          tint={isDark ? "dark" : "light"}
          experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={sheenColors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {/* Crisp top specular rim */}
        <View
          pointerEvents="none"
          style={[
            styles.specularRim,
            {
              backgroundColor: isDark
                ? "rgba(255, 255, 255, 0.24)"
                : "rgba(255, 255, 255, 0.94)",
            },
          ]}
        />
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 8,
  },
  inner: {
    overflow: "hidden",
    borderWidth: 1,
  },
  specularRim: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    height: 1.5,
    borderRadius: 1,
  },
});
