import { StyleSheet, View } from "react-native";
import type { DimensionValue } from "react-native";
import { useThemedStyles } from "./SkinProvider";
import { CHROME, RADIUS } from "./layoutTokens";
import type { UiPalette } from "./skinTokens";

const ROWS = [0, 1, 2] as const;
const CHAT_WIDTHS = ["52%", "66%", "42%", "57%"] as const;

export function ScreenSkeleton({ variant, label }: {
  variant: "feed" | "list" | "chat";
  label: string;
}) {
  const styles = useThemedStyles(createStyles);
  const block = (width: DimensionValue) => <View style={[styles.block, styles.line, { width }]} />;

  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label}
      aria-busy style={variant === "chat" ? styles.chat : styles.stack}>
      {variant === "chat" ? CHAT_WIDTHS.map((width, index) => (
        <View key={width} style={[styles.block, styles.bubble, { width }, index % 2 === 1 && styles.bubbleRight]} />
      )) : ROWS.map(row => (
        <View key={row} style={variant === "feed" ? styles.card : styles.listItem}>
          <View style={styles.row}>
            <View style={[styles.block, styles.avatar]} />
            <View style={styles.copy}>{block("36%")}{block(variant === "feed" ? "23%" : "64%")}</View>
          </View>
          {variant === "feed" && <View style={styles.stack}>{block("92%")}{block("63%")}</View>}
        </View>
      ))}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  stack: { gap: 12 },
  chat: { flex: 1, justifyContent: "flex-end", padding: CHROME.screenInset, gap: 12 },
  card: { gap: 12, padding: CHROME.screenInset, borderRadius: RADIUS.bubble, backgroundColor: ui.white },
  listItem: { paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  copy: { flex: 1, gap: 8 },
  block: { backgroundColor: ui.ink, opacity: 0.12 },
  line: { height: 10, borderRadius: RADIUS.pill },
  avatar: { width: 40, height: 40, borderRadius: RADIUS.pill },
  bubble: { height: 40, borderRadius: RADIUS.bubble },
  bubbleRight: { alignSelf: "flex-end" },
});
