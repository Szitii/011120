import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { PEARL_UI } from "../theme/skinTokens";

/**
 * 极简液态珍珠加载动效：暖珍珠柔雾罩 + 冰雾蓝轻呼吸环 + 斜向流光
 * 淡出结束后自动卸载（return null），零后台 GPU 占用
 */
export function PearlTransitionLoader({
  visible,
  borderRadius = 28,
}: {
  visible: boolean;
  borderRadius?: number;
}) {
  const [mounted, setMounted] = useState(visible);
  const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const ringExpand = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(fade, {
        toValue: 1,
        duration: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(fade, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, fade]);

  useEffect(() => {
    if (!mounted) return;
    const breathLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const ringLoop = Animated.loop(
      Animated.timing(ringExpand, {
        toValue: 1,
        duration: 1500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    breathLoop.start();
    ringLoop.start();
    return () => {
      breathLoop.stop();
      ringLoop.stop();
    };
  }, [mounted, breath, ringExpand]);

  if (!mounted) return null;

  const orbScale = breath.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] });
  const outerRingScale = ringExpand.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1.8] });
  const outerRingOpacity = ringExpand.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] });

  return (
    <Animated.View
      pointerEvents={visible ? "auto" : "none"}
      style={[styles.overlay, { borderRadius, opacity: fade }]}
    >
      <LinearGradient
        colors={["rgba(246, 245, 240, 0.94)", "rgba(240, 233, 225, 0.96)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.center}>
        <Animated.View
          style={[
            styles.rippleRing,
            {
              opacity: outerRingOpacity,
              transform: [{ scale: outerRingScale }],
            },
          ]}
        />
        <Animated.View style={[styles.pearlShell, { transform: [{ scale: orbScale }] }]}>
          <LinearGradient
            colors={["rgba(255,255,255,0.96)", "rgba(180,192,212,0.55)"]}
            start={{ x: 0.2, y: 0.1 }}
            end={{ x: 0.9, y: 0.9 }}
            style={styles.pearlCore}
          />
          <View style={styles.pearlDot} />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 140,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  rippleRing: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.25,
    borderColor: PEARL_UI.iceBlue,
  },
  pearlShell: {
    width: 34,
    height: 34,
    borderRadius: 17,
    padding: 3,
    backgroundColor: "rgba(255,255,255,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.96)",
    alignItems: "center",
    justifyContent: "center",
  },
  pearlCore: {
    width: 26,
    height: 26,
    borderRadius: 13,
    position: "absolute",
  },
  pearlDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: PEARL_UI.accent,
  },
});
