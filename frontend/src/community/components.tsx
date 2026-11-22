import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { CommunityActor, CommunityComment, CommunityPost } from "../../../contracts/community.ts";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { PixelAvatar } from "../components/PixelAvatar";
import { CHROME, RADIUS } from "../theme/layoutTokens";
import { PEARL_UI } from "../theme/skinTokens";

function formatRelativeTime(iso: string): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CommunityButton({
  label,
  onPress,
  disabled = false,
  selected = false,
  glass = false,
  primary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  glass?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        communityStyles.button,
        glass && communityStyles.glassFilter,
        selected && !glass && communityStyles.selected,
        primary && communityStyles.primaryBtn,
        disabled && { opacity: 0.45 },
        pressed && !disabled && { transform: [{ scale: 0.96 }] },
      ]}
    >
      {glass && (
        <LiquidGlassSurface
          glass
          tint="light"
          style={[StyleSheet.absoluteFill, selected && communityStyles.selectedFilter]}
        />
      )}
      <Text
        style={[
          communityStyles.buttonText,
          selected && communityStyles.selectedText,
          (primary || (glass && selected)) && communityStyles.primaryText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ActorLine({
  actor,
  onPress,
  subtitle,
}: {
  actor: CommunityActor;
  onPress: () => void;
  subtitle?: string;
}) {
  const isAi = actor.kind === "AI";
  const actorAvatar = "avatar" in actor && typeof (actor as { avatar?: unknown }).avatar === "string" ? (actor as { avatar?: string }).avatar : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看${actor.displayName}的主页`}
      onPress={onPress}
      style={communityStyles.actorRow}
    >
      <PixelAvatar
        name={actor.displayName}
        role={isAi ? "companion" : "owner"}
        uri={actorAvatar}
        size={36}
      />
      <View style={communityStyles.actorTextWrap}>
        <View style={communityStyles.actorNameLine}>
          <Text style={communityStyles.author} numberOfLines={1}>{actor.displayName}</Text>
          <View style={[communityStyles.roleTag, isAi && communityStyles.roleTagAi]}>
            <Text style={[communityStyles.roleTagText, isAi && communityStyles.roleTagAiText]}>
              {isAi ? "AI" : "人类"}
            </Text>
          </View>
        </View>
        {subtitle ? <Text style={communityStyles.meta}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}

export function ContentCard({
  item,
  onActor,
  onDetail,
  onDelete,
  onReport,
}: {
  item: CommunityPost | CommunityComment;
  onActor: () => void;
  onDetail?: () => void;
  onDelete: () => void;
  onReport?: () => void;
}) {
  const timeText = formatRelativeTime(item.createdAt);
  const subtitle = item.source === "OWNER_PROXY" ? `${timeText} · Owner 代发` : timeText;

  return (
    <View style={communityStyles.card}>
      <ActorLine actor={item.author} onPress={onActor} subtitle={subtitle} />
      <Text selectable style={communityStyles.body}>{item.body}</Text>
      <View style={communityStyles.cardFooter}>
        <View style={communityStyles.cardFooterLeft}>
          {onDetail && "commentsCount" in item && (
            <Pressable
              accessibilityRole="button"
              onPress={onDetail}
              style={({ pressed }) => [communityStyles.actionChip, pressed && { opacity: 0.65 }]}
            >
              <Ionicons name="chatbubble-outline" size={14} color={PEARL_UI.muted} />
              <Text style={communityStyles.actionChipText}>{item.commentsCount}</Text>
            </Pressable>
          )}
        </View>
        <View style={communityStyles.cardFooterRight}>
          {onReport && (
            <Pressable
              accessibilityRole="button"
              onPress={onReport}
              style={({ pressed }) => [communityStyles.textActionBtn, pressed && { opacity: 0.6 }]}
            >
              <Text style={communityStyles.textActionLabel}>举报</Text>
            </Pressable>
          )}
          {item.canDelete && (
            <Pressable
              accessibilityRole="button"
              onPress={onDelete}
              style={({ pressed }) => [communityStyles.textActionBtn, pressed && { opacity: 0.6 }]}
            >
              <Text style={[communityStyles.textActionLabel, { color: "#984C59" }]}>删除</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

export const communityStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PEARL_UI.background[0] },
  communityPage: { flex: 1 },
  content: { paddingHorizontal: CHROME.screenInset, paddingTop: 8, paddingBottom: 48, gap: 12 },
  feedContent: { paddingBottom: CHROME.scrollBottomClearance },
  title: { fontSize: 22, fontWeight: "700", color: PEARL_UI.ink, letterSpacing: -0.3 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIUS.pill,
    backgroundColor: "rgba(255,255,255,0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PEARL_UI.line,
    minHeight: 38,
    justifyContent: "center",
    alignItems: "center",
  },
  glassFilter: { backgroundColor: "transparent", borderWidth: 0 },
  selected: { backgroundColor: PEARL_UI.accentWash, borderColor: "transparent" },
  selectedFilter: { backgroundColor: "rgba(123,144,172,0.82)" },
  primaryBtn: { backgroundColor: PEARL_UI.accent, borderColor: "transparent" },
  buttonText: { color: PEARL_UI.accentInk, fontSize: 13, fontWeight: "600" },
  selectedText: { fontWeight: "700" },
  primaryText: { color: "#FFFFFF", fontWeight: "600" },
  card: {
    backgroundColor: PEARL_UI.white,
    padding: 16,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PEARL_UI.line,
    gap: 10,
    shadowColor: "#8A857C",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 1,
  },
  actorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  actorTextWrap: { flex: 1, minWidth: 0 },
  actorNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  author: { fontSize: 15, color: PEARL_UI.ink, fontWeight: "600", flexShrink: 1 },
  roleTag: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
    backgroundColor: PEARL_UI.background[1],
  },
  roleTagAi: { backgroundColor: PEARL_UI.accentWash },
  roleTagText: { fontSize: 10, fontWeight: "600", color: PEARL_UI.muted },
  roleTagAiText: { color: PEARL_UI.accentInk },
  meta: { fontSize: 11.5, color: PEARL_UI.muted, lineHeight: 17, marginTop: 1 },
  body: { fontSize: 15, lineHeight: 23, color: PEARL_UI.ink },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(36, 35, 34, 0.05)",
  },
  cardFooterLeft: { flexDirection: "row", alignItems: "center", gap: 14 },
  cardFooterRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  actionChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, paddingHorizontal: 2 },
  actionChipText: { fontSize: 12.5, color: PEARL_UI.muted, fontWeight: "500" },
  textActionBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  textActionLabel: { fontSize: 12, color: PEARL_UI.muted, fontWeight: "500" },
  input: {
    minHeight: 110,
    textAlignVertical: "top",
    backgroundColor: PEARL_UI.background[0],
    borderWidth: 1,
    borderColor: PEARL_UI.line,
    borderRadius: 16,
    padding: 14,
    fontSize: 15,
    color: PEARL_UI.ink,
  },
  error: { color: "#984C59", fontSize: 13, lineHeight: 20 },
});
