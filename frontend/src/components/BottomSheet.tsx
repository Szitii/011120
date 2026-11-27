import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { CHROME, RADIUS } from "../theme/layoutTokens";

export function BottomSheet({
  visible,
  title,
  badge,
  avoidKeyboard = false,
  onClose,
  children,
}: {
  visible: boolean;
  title?: string;
  badge?: string;
  avoidKeyboard?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { skin, ui } = useSkin();
  const styles = useThemedStyles(createStyles);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const Backdrop = avoidKeyboard && Platform.OS === "ios" ? KeyboardAvoidingView : View;

  useEffect(() => {
    if (!visible || !avoidKeyboard || Platform.OS !== "web" || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [visible, avoidKeyboard]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[styles.safe, { backgroundColor: ui.scrim }]}>
        <Backdrop behavior={Backdrop === KeyboardAvoidingView ? "padding" : undefined}
          style={[styles.backdrop, avoidKeyboard && keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
          <View accessibilityViewIsModal
            style={[styles.panel, { backgroundColor: ui.background[0], borderColor: skin.colors.border }]}>
            <View style={[styles.handle, { backgroundColor: skin.colors.border }]} />
            {title && (
              <View style={styles.header}>
                <Text accessibilityRole="header" style={[styles.title, { color: skin.colors.ink }]}>{title}</Text>
                {badge && (
                  <Text style={[styles.badge, { color: skin.colors.inkSub, backgroundColor: skin.colors.surface }]}>{badge}</Text>
                )}
              </View>
            )}
            <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {children}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭弹层" onPress={onClose} style={styles.close}>
              <Text style={[styles.closeLabel, { color: skin.colors.ink }]}>关闭</Text>
            </Pressable>
          </View>
        </Backdrop>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = () => StyleSheet.create({
  safe: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "flex-end", paddingTop: CHROME.screenInset },
  panel: { borderTopLeftRadius: RADIUS.roomFrame, borderTopRightRadius: RADIUS.roomFrame, borderTopWidth: 1,
    maxHeight: "100%", paddingHorizontal: CHROME.screenInset, paddingTop: CHROME.screenInset },
  body: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: "700", flexShrink: 1 },
  close: { minHeight: 44, justifyContent: "center", alignSelf: "flex-end", paddingHorizontal: 12 },
  closeLabel: { fontSize: 14 },
  badge: { maxWidth: "100%", fontSize: 10.5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.pill, overflow: "hidden" },
});
