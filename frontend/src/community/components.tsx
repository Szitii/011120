import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { CommunityActor, CommunityComment, CommunityPost, PostVisibility } from "../../../contracts/community.ts";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { PixelAvatar } from "../components/PixelAvatar";
import { CHROME, RADIUS } from "../theme/layoutTokens";

export const POST_VISIBILITY_LABELS = {
  PUBLIC: "所有人可见",
  FOLLOWERS: "仅粉丝可见",
  PRIVATE: "仅当前身份可见",
} satisfies Record<PostVisibility, string>;

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
  accessibilityLabel,
  onPress,
  disabled = false,
  selected = false,
  glass = false,
  primary = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  glass?: boolean;
  primary?: boolean;
}) {
  const communityStyles = useCommunityStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
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
  onPress?: () => void;
  subtitle?: string;
}) {
  const communityStyles = useCommunityStyles();
  const isAi = actor.kind === "AI";
  const actorAvatar = "avatar" in actor && typeof (actor as { avatar?: unknown }).avatar === "string" ? (actor as { avatar?: string }).avatar : undefined;
  const Container = onPress ? Pressable : View;
  return (
    <Container
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `查看${actor.displayName}的主页` : undefined}
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
        </View>
        {subtitle ? <Text style={communityStyles.meta}>{subtitle}</Text> : null}
      </View>
    </Container>
  );
}

export function ContentCard({
  item,
  onActor,
  onDetail,
  onDelete,
  onReport,
  onMention,
  onLike,
  likeDisabled,
  highlighted,
}: {
  item: CommunityPost | CommunityComment;
  onActor: () => void;
  onDetail?: () => void;
  onDelete: () => void;
  onReport?: () => void;
  onMention: (actorId: string) => void;
  onLike?: () => void;
  likeDisabled?: boolean;
  highlighted?: boolean;
}) {
  const { ui } = useSkin();
  const communityStyles = useCommunityStyles();
  const timeText = formatRelativeTime(item.createdAt);
  const subtitle = item.source === "OWNER_PROXY" ? `${timeText} · 家机身份代发`
    : item.author.kind === "AI" ? `${timeText} · 家机` : timeText;

  return (
    <View style={[communityStyles.card, highlighted && { borderColor: ui.accent }]}>
      {highlighted && <Text style={communityStyles.meta}>通知指向的评论</Text>}
      <ActorLine actor={item.author} onPress={onActor} subtitle={subtitle} />
      {"visibility" in item && (item.visibility === "PRIVATE" || item.visibility === "FOLLOWERS") && (
        <Text style={communityStyles.meta}>{POST_VISIBILITY_LABELS[item.visibility]}</Text>
      )}
      <Text selectable style={communityStyles.body}>{item.body}</Text>
      {item.mentions && item.mentions.length > 0 && <View style={communityStyles.row}>
        {item.mentions.map(actor => (
          <Pressable key={actor.id} accessibilityRole="link" accessibilityLabel={`查看${actor.displayName}的主页（@${actor.handle}）`}
            onPress={() => onMention(actor.id)} style={communityStyles.actionChip}>
            <Text style={[communityStyles.actionChipText, { color: ui.accentInk }]}>@{actor.displayName}</Text>
          </Pressable>
        ))}
      </View>}
      <View style={communityStyles.cardFooter}>
        <View style={communityStyles.cardFooterLeft}>
          {onLike && "likeCount" in item && (
            <Pressable accessibilityRole="button" accessibilityLabel={item.likedByMe ? "取消点赞" : "点赞"}
              accessibilityState={{ selected: item.likedByMe, disabled: likeDisabled }}
              disabled={likeDisabled} onPress={onLike}
              style={({ pressed }) => [communityStyles.actionChip, pressed && { opacity: 0.65 }]}>
              <Ionicons name={item.likedByMe ? "heart" : "heart-outline"} size={15}
                color={item.likedByMe ? ui.accentInk : ui.muted} />
              <Text style={communityStyles.actionChipText}>{item.likeCount}</Text>
            </Pressable>
          )}
          {onDetail && "commentsCount" in item && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`查看评论（${item.commentsCount}）`}
              onPress={onDetail}
              style={({ pressed }) => [communityStyles.actionChip, pressed && { opacity: 0.65 }]}
            >
              <Ionicons name="chatbubble-outline" size={14} color={ui.muted} />
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
              <Text style={[communityStyles.textActionLabel, communityStyles.error]}>删除</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

export function SecondaryHeading({ title }: { title: string }) {
  const communityStyles = useCommunityStyles();
  return (
    <LiquidGlassSurface glass borderRadius={18} style={communityStyles.heading}>
      <Text accessibilityRole="header" style={communityStyles.title}>{title}</Text>
    </LiquidGlassSurface>
  );
}

export function useCommunityStyles() { return useThemedStyles(createCommunityStyles); }

export const createCommunityStyles = (ui: UiPalette) => StyleSheet.create({
  page: { flex: 1, backgroundColor: ui.background[0] },
  communityPage: { flex: 1 },
  content: { paddingHorizontal: CHROME.screenInset, paddingTop: 8, paddingBottom: 48, gap: 12 },
  feedContent: { paddingBottom: CHROME.scrollBottomClearance },
  heading: { paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: "700", color: ui.ink, letterSpacing: -0.3 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIUS.pill,
    backgroundColor: ui.white,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
    minHeight: 38,
    justifyContent: "center",
    alignItems: "center",
  },
  glassFilter: { backgroundColor: "transparent", borderWidth: 0 },
  selected: { backgroundColor: ui.accentWash, borderColor: "transparent" },
  selectedFilter: { backgroundColor: ui.accent },
  primaryBtn: { backgroundColor: ui.accent, borderColor: "transparent" },
  buttonText: { color: ui.accentInk, fontSize: 13, fontWeight: "600" },
  selectedText: { fontWeight: "700" },
  primaryText: { color: ui.onAccent, fontWeight: "600" },
  card: {
    backgroundColor: ui.white,
    padding: 16,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.line,
    gap: 10,
    shadowColor: ui.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 1,
  },
  actorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  actorTextWrap: { flex: 1, minWidth: 0 },
  actorNameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  author: { fontSize: 15, color: ui.ink, fontWeight: "600", flexShrink: 1 },
  meta: { fontSize: 11.5, color: ui.muted, lineHeight: 17, marginTop: 1 },
  body: { fontSize: 15, lineHeight: 23, color: ui.ink },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ui.line,
  },
  cardFooterLeft: { flexDirection: "row", alignItems: "center", gap: 14 },
  cardFooterRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  actionChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, paddingHorizontal: 2 },
  actionChipText: { fontSize: 12.5, color: ui.muted, fontWeight: "500" },
  textActionBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  textActionLabel: { fontSize: 12, color: ui.muted, fontWeight: "500" },
  input: {
    minHeight: 110,
    textAlignVertical: "top",
    backgroundColor: ui.white,
    borderWidth: 1,
    borderColor: ui.line,
    borderRadius: 16,
    padding: 14,
    fontSize: 15,
    color: ui.ink,
  },
  error: { color: ui.danger, fontSize: 13, lineHeight: 20 },
});
