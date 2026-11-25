import { useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import { useState } from "react";
import { Image, StyleSheet, View, type ImageSourcePropType } from "react-native";

type AvatarRole = "owner" | "companion";

export const avatarPresets = [
  { value: "preset:pixel_long_hair", label: "长发像素", image: require("../../assets/avatar-owner-pixel.png") },
  { value: "preset:pixel_short_hair", label: "短发像素", image: require("../../assets/avatar-companion-pixel.png") },
] as const;

const pixelAvatars: Record<AvatarRole, ImageSourcePropType> = {
  owner: avatarPresets[0].image,
  companion: avatarPresets[1].image,
};

export function PixelAvatar({
  name,
  role,
  uri,
  size,
}: {
  name: string;
  role: AvatarRole;
  uri?: string | null;
  size: number;
}) {
  const styles = useThemedStyles(createStyles);

  const radius = Math.round(size * 0.34);
  const frame = { width: size, height: size, borderRadius: radius };
  const preset = uri?.startsWith("preset:") ? avatarPresets.find(option => option.value === uri) : undefined;

  return (
    <View
      accessibilityLabel={name}
      style={[styles.frame, frame, role === "companion" && styles.companion]}
    >
      <Image
        source={preset?.image ?? pixelAvatars[role]}
        style={styles.image}
        resizeMode="cover"
        fadeDuration={0}
      />
      {uri && !uri.startsWith("preset:") && <RemoteAvatar key={uri} uri={uri} />}
    </View>
  );
}

function RemoteAvatar({ uri }: { uri: string }) {
  const styles = useThemedStyles(createStyles);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <Image source={{ uri }} style={[styles.remoteImage, { opacity: ready ? 1 : 0 }]}
    resizeMode="cover" fadeDuration={120} onLoad={() => setReady(true)} onError={() => setFailed(true)} />;
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  frame: {
    backgroundColor: ui.background[0],
    borderWidth: 1.5,
    borderColor: ui.highlight,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: ui.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 1,
  },
  companion: {
    backgroundColor: ui.accentWash,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  remoteImage: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: "100%",
    height: "100%",
  },
});
