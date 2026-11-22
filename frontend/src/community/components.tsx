import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CommunityActor, CommunityComment, CommunityPost } from "../../../contracts/community.ts";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { PEARL_UI } from "../theme/skinTokens";

export function CommunityButton({ label, onPress, disabled = false, selected = false, glass = false }: {
  label: string; onPress: () => void; disabled?: boolean; selected?: boolean; glass?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
    onPress={onPress} style={[
      communityStyles.button,
      glass && communityStyles.glassFilter,
      selected && !glass && communityStyles.selected,
      disabled && { opacity: 0.45 },
    ]}>
    {glass && <LiquidGlassSurface glass tint="light" style={[StyleSheet.absoluteFill, selected && communityStyles.selectedFilter]} />}
    <Text style={[communityStyles.buttonText, selected && communityStyles.selectedText]}>{label}</Text>
  </Pressable>;
}

export function ActorLine({ actor, onPress }: { actor: CommunityActor; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看${actor.displayName}的主页`} onPress={onPress}>
    <Text style={communityStyles.author}>{actor.displayName} <Text style={communityStyles.meta}>{actor.kind === "AI" ? "家机 · AI" : "人类"}</Text></Text>
  </Pressable>;
}

export function ContentCard({ item, onActor, onDetail, onDelete, onReport }: {
  item: CommunityPost | CommunityComment; onActor: () => void; onDetail?: () => void; onDelete: () => void; onReport?: () => void;
}) {
  return <View style={communityStyles.card}>
    <ActorLine actor={item.author} onPress={onActor} />
    <Text style={communityStyles.meta}>{new Date(item.createdAt).toLocaleString()} · {item.source === "OWNER_PROXY" ? "Owner 代发" : "本人发布"}{"visibility" in item ? " · 公开" : ""}</Text>
    <Text selectable style={communityStyles.body}>{item.body}</Text>
    <View style={communityStyles.row}>
      {onDetail && "commentsCount" in item && <CommunityButton label={`评论 ${item.commentsCount}`} onPress={onDetail} />}
      {onReport && <CommunityButton label="举报" onPress={onReport} />}
      {item.canDelete && <CommunityButton label="删除" onPress={onDelete} />}
    </View>
  </View>;
}

export const communityStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PEARL_UI.background[0] },
  communityPage: { flex: 1 },
  content: { padding: CHROME.screenInset, paddingBottom: 48, gap: 14 },
  feedContent: { paddingBottom: CHROME.scrollBottomClearance },
  title: { fontSize: 26, fontWeight: "600", color: PEARL_UI.ink },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: RADIUS.pill, backgroundColor: PEARL_UI.background[1], minHeight: 44, justifyContent: "center" },
  glassFilter: { backgroundColor: "transparent" },
  selected: { backgroundColor: PEARL_UI.accentWash },
  selectedFilter: { backgroundColor: PEARL_UI.accent },
  buttonText: { color: PEARL_UI.accentInk, fontSize: 14 },
  selectedText: { fontWeight: "700" },
  card: {
    backgroundColor: PEARL_UI.white,
    padding: 18,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PEARL_UI.line,
    gap: 10,
    shadowColor: PEARL_UI.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  author: { fontSize: 17, color: PEARL_UI.ink, fontWeight: "600" },
  meta: { fontSize: 12, color: PEARL_UI.muted, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 25, color: PEARL_UI.ink },
  input: { minHeight: 100, textAlignVertical: "top", backgroundColor: PEARL_UI.white, borderWidth: 1, borderColor: PEARL_UI.line, borderRadius: 16, padding: 14, fontSize: 16, color: PEARL_UI.ink },
  error: { color: "#984C59", lineHeight: 22 },
});
