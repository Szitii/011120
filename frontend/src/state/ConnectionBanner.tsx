import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useThemedStyles } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";
import { hasConnectionIssue, subscribeToConnectionStatus } from "./connection-status";

export function ConnectionBanner({ active }: { active: boolean }) {
  const styles = useThemedStyles(createStyles);
  const connectionIssue = useSyncExternalStore(subscribeToConnectionStatus, hasConnectionIssue, () => false);
  const [browserOffline, setBrowserOffline] = useState(false);

  useEffect(() => {
    if (!active || Platform.OS !== "web" || typeof window === "undefined") return;
    const update = () => setBrowserOffline(window.navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [active]);

  if (!active || (!browserOffline && !connectionIssue)) return null;

  return (
    <View style={styles.banner}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.label}>
        {browserOffline ? "当前离线，联网后可重试。" : "网络连接不稳定，可以稍后重试。"}
      </Text>
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  banner: {
    marginHorizontal: CHROME.screenInset,
    paddingHorizontal: CHROME.screenInset,
    paddingVertical: 6,
    borderRadius: RADIUS.bubble,
    backgroundColor: ui.white,
    borderColor: ui.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: { color: ui.muted, fontSize: 12, textAlign: "center" },
});
