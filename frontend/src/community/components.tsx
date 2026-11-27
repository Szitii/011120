import { useThemedStyles, useSkin } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, PanResponder, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { CommunityActor, CommunityComment, CommunityPost, PostMedia, PostVisibility } from "../../../contracts/community.ts";
import { LiquidGlassSurface } from "../components/LiquidGlassSurface";
import { PixelAvatar } from "../components/PixelAvatar";
import { CHROME, RADIUS } from "../theme/layoutTokens";

export const POST_VISIBILITY_LABELS = {
  PUBLIC: "所有人可见",
  FOLLOWERS: "仅粉丝可见",
  PRIVATE: "仅当前身份可见",
} satisfies Record<PostVisibility, string>;

export function communityIdentityLabel(kind?: CommunityActor["kind"]): string | undefined {
  if (kind === "HUMAN") return "真人";
  if (kind === "AI") return "家机";
  return undefined;
}

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

type MediaSource = { uri: string; headers: Record<string, string> };
type MediaResolver = (path: string) => Promise<MediaSource | undefined>;
const LIGHTBOX_SWIPE_DISTANCE = 40;

export function AuthPostImage({
  media,
  resolveMedia,
  style,
  contentFit = "cover",
  cacheScope,
  draggable,
}: {
  media: PostMedia;
  resolveMedia?: MediaResolver;
  style: Record<string, unknown>;
  contentFit?: "cover" | "contain";
  cacheScope?: string;
  draggable?: boolean;
}) {
  const { ui } = useSkin();
  const cacheKey = cacheScope ? `${cacheScope}:${media.path}` : media.path;
  const [resolved, setResolved] = useState<{ key: string; source?: MediaSource }>();

  useEffect(() => {
    let active = true;
    setResolved(undefined);
    if (!resolveMedia) {
      setResolved({ key: cacheKey });
      return;
    }
    void resolveMedia(media.path).then(source => {
      if (active) setResolved({ key: cacheKey, source });
    }).catch(() => {
      if (active) setResolved({ key: cacheKey });
    });
    return () => { active = false; };
  }, [media.path, resolveMedia, cacheKey]);

  const current = resolved?.key === cacheKey ? resolved : undefined;
  if (current && !current.source) {
    return (
      <View style={[{ backgroundColor: ui.background[0], alignItems: "center", justifyContent: "center" }, style]}>
        <Ionicons name="image-outline" size={20} color={ui.muted} />
      </View>
    );
  }
  if (!current?.source) {
    return <View style={[{ backgroundColor: ui.background[0] }, style]} />;
  }
  return (
    <Image
      source={{ ...current.source, cacheKey }}
      recyclingKey={cacheKey}
      cachePolicy="memory"
      accessibilityLabel={media.alt ?? "动态图片"}
      contentFit={contentFit}
      draggable={draggable}
      style={style}
      onError={() => setResolved({ key: cacheKey })}
    />
  );
}

function PostMediaGrid({ media, resolveMedia, cacheScope }: { media: PostMedia[]; resolveMedia?: MediaResolver; cacheScope?: string }) {
  const s = useCommunityStyles();
  const [previewIndex, setPreviewIndex] = useState<number>();
  const images = media.filter(item => item.kind === "IMAGE").slice(0, 9);
  if (images.length === 0) return null;

  const single = images.length === 1 ? images[0] : undefined;
  const singleRatio = single && single.width && single.height
    ? Math.max(0.75, Math.min(1.8, single.width / single.height))
    : 4 / 3;
  const twoCol = images.length === 2 || images.length === 4;

  return (
    <>
      {single ? (
        <Pressable accessibilityRole="button" accessibilityLabel={single.alt ?? "查看大图"} onPress={() => setPreviewIndex(0)}>
          <AuthPostImage
            media={single}
            resolveMedia={resolveMedia}
            cacheScope={cacheScope}
            style={{ width: "100%", aspectRatio: singleRatio, maxHeight: 320, borderRadius: 14, overflow: "hidden" }}
          />
        </Pressable>
      ) : (
        <View style={s.mediaGrid}>
          {images.map((item, idx) => (
            <Pressable
              key={`${item.path}-${idx}`}
              accessibilityRole="button"
              accessibilityLabel={item.alt ?? `查看第 ${idx + 1} 张图片`}
              onPress={() => setPreviewIndex(idx)}
              style={twoCol ? s.mediaTileTwo : s.mediaTileThree}
            >
              <AuthPostImage media={item} resolveMedia={resolveMedia} cacheScope={cacheScope} style={{ width: "100%", height: "100%" }} />
            </Pressable>
          ))}
        </View>
      )}
      {previewIndex !== undefined && (
        <MediaLightbox images={images} initialIndex={Math.min(previewIndex, images.length - 1)}
          resolveMedia={resolveMedia} cacheScope={cacheScope} onClose={() => setPreviewIndex(undefined)} />
      )}
    </>
  );
}

function MediaLightbox({ images, initialIndex, resolveMedia, cacheScope, onClose }: {
  images: PostMedia[];
  initialIndex: number;
  resolveMedia?: MediaResolver;
  cacheScope?: string;
  onClose: () => void;
}) {
  const s = useCommunityStyles();
  const { ui } = useSkin();
  const [index, setIndex] = useState(initialIndex);
  const lastIndex = images.length - 1;
  const visibleIndex = Math.min(index, lastIndex);
  const move = useCallback((step: number) => {
    setIndex(current => Math.max(0, Math.min(lastIndex, Math.min(current, lastIndex) + step)));
  }, [lastIndex]);
  const swipe = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => lastIndex > 0,
    onPanResponderRelease: (_, { dx, dy }) => {
      if (Math.abs(dx) >= LIGHTBOX_SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
        move(dx < 0 ? 1 : -1);
      }
    },
  }), [lastIndex, move]);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={s.mediaModal} accessibilityViewIsModal>
        <View style={s.mediaToolbar}>
          <Text accessibilityLiveRegion="polite" style={s.mediaCount}>{visibleIndex + 1} / {images.length}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭大图预览"
            onPress={onClose} style={s.mediaControl}>
            <Ionicons name="close" size={22} color={ui.onDark} />
          </Pressable>
        </View>
        <View style={s.mediaStage}>
          <View style={s.mediaFrame} {...swipe.panHandlers}>
            <AuthPostImage media={images[visibleIndex]} resolveMedia={resolveMedia} cacheScope={cacheScope}
              contentFit="contain" draggable={false} style={s.mediaImage} />
          </View>
          {lastIndex > 0 && (
            <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.mediaNavigation]}>
              <Pressable accessibilityRole="button" accessibilityLabel="上一张图片"
                disabled={visibleIndex === 0} onPress={() => move(-1)}
                style={[s.mediaControl, visibleIndex === 0 && s.mediaControlDisabled]}>
                <Ionicons name="chevron-back" size={22} color={ui.onDark} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="下一张图片"
                disabled={visibleIndex === lastIndex} onPress={() => move(1)}
                style={[s.mediaControl, visibleIndex === lastIndex && s.mediaControlDisabled]}>
                <Ionicons name="chevron-forward" size={22} color={ui.onDark} />
              </Pressable>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
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
  resolveMedia,
  cacheScope,
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
  resolveMedia?: MediaResolver;
  cacheScope?: string;
}) {
  const { ui } = useSkin();
  const communityStyles = useCommunityStyles();
  const timeText = formatRelativeTime(item.createdAt);
  const subtitle = [timeText, communityIdentityLabel(item.author.kind)].filter(Boolean).join(" · ");

  return (
    <View style={[communityStyles.card, highlighted && { borderColor: ui.accent }]}>
      {highlighted && <Text style={communityStyles.meta}>通知指向的评论</Text>}
      <ActorLine actor={item.author} onPress={onActor} subtitle={subtitle} />
      {"visibility" in item && (item.visibility === "PRIVATE" || item.visibility === "FOLLOWERS") && (
        <Text style={communityStyles.meta}>{POST_VISIBILITY_LABELS[item.visibility]}</Text>
      )}
      <Text selectable style={communityStyles.body}>{item.body}</Text>
      {"media" in item && Array.isArray(item.media) && item.media.length > 0 && (
        <PostMediaGrid media={item.media} resolveMedia={resolveMedia} cacheScope={cacheScope} />
      )}
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
  mediaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  mediaTileTwo: { width: "48.5%", aspectRatio: 1, borderRadius: 12, overflow: "hidden" },
  mediaTileThree: { width: "31.8%", aspectRatio: 1, borderRadius: 12, overflow: "hidden" },
  mediaModal: { flex: 1, width: "100%", height: "100%", backgroundColor: ui.lightboxScrim },
  mediaToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: CHROME.screenInset },
  mediaCount: { overflow: "hidden", color: ui.onDark, backgroundColor: ui.lightboxScrim, borderRadius: RADIUS.pill,
    paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, fontWeight: "600" },
  mediaControl: { width: 44, height: 44, borderRadius: RADIUS.pill, backgroundColor: ui.lightboxScrim,
    alignItems: "center", justifyContent: "center" },
  mediaControlDisabled: { opacity: 0.4 },
  mediaStage: { flex: 1, alignItems: "center", justifyContent: "center" },
  mediaFrame: { width: "92%", height: "78%" },
  mediaImage: { width: "100%", height: "100%", backgroundColor: "transparent" },
  mediaNavigation: { flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", paddingHorizontal: CHROME.screenInset },
});
