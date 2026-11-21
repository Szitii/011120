import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CommunityActor, CommunityComment, CommunityPost } from "../../../../packages/community-contracts/types.ts";

export function CommunityButton({ label, onPress, disabled = false, selected = false }: {
  label: string; onPress: () => void; disabled?: boolean; selected?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
    onPress={onPress} style={[communityStyles.button, selected && communityStyles.selected, disabled && { opacity: 0.45 }]}>
    <Text style={communityStyles.buttonText}>{label}</Text>
  </Pressable>;
}

export function ActorLine({ actor, onPress }: { actor: CommunityActor; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看${actor.displayName}的主页`} onPress={onPress}>
    <Text style={communityStyles.author}>{actor.displayName} <Text style={communityStyles.meta}>{actor.kind === "AI" ? "家机 · AI" : "人类"}</Text></Text>
  </Pressable>;
}

export function ContentCard({ item, onActor, onDetail, onDelete }: {
  item: CommunityPost | CommunityComment; onActor: () => void; onDetail?: () => void; onDelete: () => void;
}) {
  return <View style={communityStyles.card}>
    <ActorLine actor={item.author} onPress={onActor} />
    <Text style={communityStyles.meta}>{new Date(item.createdAt).toLocaleString()} · {item.source === "OWNER_PROXY" ? "Owner 代发" : "本人发布"}{"visibility" in item ? " · 公开" : ""}</Text>
    <Text selectable style={communityStyles.body}>{item.body}</Text>
    <View style={communityStyles.row}>
      {onDetail && "commentsCount" in item && <CommunityButton label={`评论 ${item.commentsCount}`} onPress={onDetail} />}
      {item.canDelete && <CommunityButton label="删除" onPress={onDelete} />}
    </View>
  </View>;
}

export const communityStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#F6F3EE" },
  content: { padding: 20, paddingBottom: 48, gap: 14 },
  title: { fontSize: 26, fontWeight: "600", color: "#3F3837" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 22, backgroundColor: "#EBE5DF", minHeight: 44 },
  selected: { backgroundColor: "#DEC6CB" },
  buttonText: { color: "#59474C", fontSize: 14 },
  card: { backgroundColor: "#FFFDFA", padding: 18, borderRadius: 20, gap: 10 },
  author: { fontSize: 17, color: "#423737", fontWeight: "600" },
  meta: { fontSize: 12, color: "#817672", lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 25, color: "#443C3B" },
  input: { minHeight: 100, textAlignVertical: "top", backgroundColor: "#FFFDFA", borderWidth: 1, borderColor: "#DFD4D0", borderRadius: 16, padding: 14, fontSize: 16, color: "#443C3B" },
  error: { color: "#984C59", lineHeight: 22 },
});
