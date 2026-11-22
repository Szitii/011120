import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSkin } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";

export function GlassChatBubble({
  senderRole,
  text,
}: {
  senderRole: "human" | "ai";
  text: string;
}) {
  const { skin } = useSkin();
  const isHuman = senderRole === "human";

  return (
    <View style={[styles.row, isHuman ? styles.end : styles.start]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isHuman ? skin.chatBubbles.humanFill : skin.chatBubbles.aiFill,
            borderColor: isHuman ? skin.chatBubbles.humanBorder : skin.chatBubbles.aiBorder,
            borderBottomRightRadius: isHuman ? RADIUS.bubbleTail : RADIUS.bubble,
            borderBottomLeftRadius: isHuman ? RADIUS.bubble : RADIUS.bubbleTail,
          },
        ]}
      >
        <BlurView
          intensity={skin.isDark ? 48 : 60}
          tint={skin.isDark ? "dark" : "light"}
          experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="none"
          style={[
            styles.topGleam,
            {
              backgroundColor: isHuman
                ? "rgba(255,255,255,0.34)"
                : skin.isDark
                  ? "rgba(255,255,255,0.18)"
                  : "rgba(255,255,255,0.92)",
            },
          ]}
        />
        <Text style={[styles.text, { color: isHuman ? skin.chatBubbles.humanText : skin.chatBubbles.aiText }]}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: "100%",
    marginVertical: 5,
  },
  start: { alignItems: "flex-start" },
  end: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: RADIUS.bubble,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.10,
    shadowRadius: 16,
    elevation: 4,
  },
  topGleam: {
    position: "absolute",
    top: 0,
    left: 10,
    right: 10,
    height: 1.5,
  },
  text: {
    fontSize: 13.5,
    lineHeight: 20,
  },
});
