import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSkin } from "../theme/SkinProvider";

export function BottomSheet({
  visible,
  title,
  badge,
  onClose,
  children,
}: {
  visible: boolean;
  title?: string;
  badge?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { skin, ui } = useSkin();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: ui.scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
        <View style={[styles.panel, { backgroundColor: ui.background[0], borderColor: skin.colors.border }]}>
          <View style={[styles.handle, { backgroundColor: skin.colors.border }]} />
          {title ? (
            <View style={styles.header}>
              <Text style={[styles.title, { color: skin.colors.ink }]}>{title}</Text>
              {badge ? (
                <Text style={[styles.badge, { color: skin.colors.inkSub, backgroundColor: skin.colors.surface }]}>
                  {badge}
                </Text>
              ) : null}
            </View>
          ) : null}
          {children}
          <Pressable accessibilityRole="button" accessibilityLabel="关闭弹层" onPress={onClose} style={styles.close}>
            <Text style={{ color: skin.colors.ink }}>关闭</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  panel: { borderTopLeftRadius: 26, borderTopRightRadius: 26, borderTopWidth: 1, padding: 20, paddingBottom: 34 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  title: { fontSize: 17, fontWeight: "700" },
  close: { minHeight: 44, justifyContent: "center", alignSelf: "flex-end", paddingHorizontal: 12 },
  badge: { fontSize: 10.5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
});
