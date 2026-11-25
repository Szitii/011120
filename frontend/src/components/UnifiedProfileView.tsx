import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CommunityProfile } from "../../../contracts/community";
import { useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { PixelAvatar } from "./PixelAvatar";

type Stats = Pick<CommunityProfile, "postsCount" | "followersCount" | "followingCount">;

export function UnifiedProfileView({ name, role, avatar, bio, subtitle, stats, onFollowList, children }: {
  name: string;
  role: "owner" | "companion";
  avatar?: string | null;
  bio?: string;
  subtitle?: string;
  stats?: Stats;
  onFollowList?: (direction: "followers" | "following") => void;
  children?: ReactNode;
}) {
  const s = useThemedStyles(createStyles);
  return (
    <View style={s.profile}>
      <PixelAvatar name={name} role={role} uri={avatar} size={74} />
      <Text accessibilityRole="header" style={s.name}>{name}</Text>
      {!!subtitle && <Text style={s.meta}>{subtitle}</Text>}
      {!!bio && <Text style={s.bio}>{bio}</Text>}
      {stats && <View style={s.stats}>
        <Stat count={stats.postsCount} label="动态" />
        <Stat count={stats.followersCount} label="粉丝" onPress={onFollowList && (() => onFollowList("followers"))} />
        <Stat count={stats.followingCount} label="关注" onPress={onFollowList && (() => onFollowList("following"))} />
      </View>}
      {children}
    </View>
  );
}

function Stat({ count, label, onPress }: { count: number; label: string; onPress?: () => void }) {
  const s = useThemedStyles(createStyles);
  const value = <><Text style={s.count}>{count}</Text><Text style={s.meta}>{label}</Text></>;
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${count}`} style={s.stat} onPress={onPress}>{value}</Pressable>
    : <View style={s.stat}>{value}</View>;
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  profile: { alignItems: "center", gap: 7 },
  name: { fontSize: 22, fontWeight: "700", textAlign: "center", color: ui.ink },
  meta: { fontSize: 12.5, textAlign: "center", color: ui.muted },
  bio: { fontSize: 14, lineHeight: 21, textAlign: "center", color: ui.ink },
  stats: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 20, marginVertical: 5 },
  stat: { minWidth: 48, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 2 },
  count: { fontSize: 18, fontWeight: "700", color: ui.ink },
});
