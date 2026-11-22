import { Image, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { PEARL_UI } from "../theme/skinTokens";

type AvatarRole = "owner" | "companion";

const pixelAvatars: Record<AvatarRole, ImageSourcePropType> = {
  owner: require("../../assets/avatar-owner-pixel.png"),
  companion: require("../../assets/avatar-companion-pixel.png"),
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
  const source = uri ? { uri } : pixelAvatars[role];
  const radius = Math.round(size * 0.34);
  const frame = { width: size, height: size, borderRadius: radius };
  return (
    <View style={[styles.frame, frame, role === "companion" && styles.companion]}>
      {source ? (
        <Image source={source} style={styles.image} resizeMode="cover" />
      ) : (
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.37) }]}>
          {name.slice(0, 1).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: "#FAF8F5",
    borderWidth: 1.5,
    borderColor: PEARL_UI.highlight,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#8A857C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 1,
  },
  companion: {
    backgroundColor: PEARL_UI.accentWash,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  initial: {
    color: PEARL_UI.accentInk,
    fontWeight: "700",
  },
});
