import { Image, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { PEARL_UI } from "../theme/skinTokens";

type AvatarRole = "owner" | "companion";

// Add local PNGs from frontend/assets/avatar-owner-pixel.png and avatar-companion-pixel.png here when supplied.
const pixelAvatars: Partial<Record<AvatarRole, ImageSourcePropType>> = {};

export function PixelAvatar({ name, role, uri, size }: {
  name: string;
  role: AvatarRole;
  uri?: string | null;
  size: number;
}) {
  const source = uri ? { uri } : pixelAvatars[role];
  const frame = { width: size, height: size, borderRadius: size * 0.29 };
  return (
    <View style={[styles.frame, frame, role === "companion" && styles.companion]}>
      {source ? <Image source={source} style={styles.image} resizeMode="cover" /> :
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.37) }]}>{name.slice(0, 1).toUpperCase()}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: PEARL_UI.background[1],
    borderWidth: 1,
    borderColor: PEARL_UI.highlight,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  companion: { backgroundColor: PEARL_UI.accentWash },
  image: { width: "100%", height: "100%" },
  initial: { color: PEARL_UI.accentInk, fontWeight: "700" },
});
