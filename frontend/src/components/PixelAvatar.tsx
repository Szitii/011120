import React, { useEffect, useState } from "react";
import { Image, StyleSheet, View, type ImageSourcePropType } from "react-native";
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
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteFailed, setRemoteFailed] = useState(false);

  useEffect(() => {
    setRemoteReady(false);
    setRemoteFailed(false);
  }, [uri]);

  const radius = Math.round(size * 0.34);
  const frame = { width: size, height: size, borderRadius: radius };
  const showRemote = Boolean(uri) && !remoteFailed;

  return (
    <View
      accessibilityLabel={name}
      style={[styles.frame, frame, role === "companion" && styles.companion]}
    >
      {/* Always render bundled pixel avatar immediately so avatar NEVER appears blank */}
      <Image
        source={pixelAvatars[role]}
        style={styles.image}
        resizeMode="cover"
        fadeDuration={0}
      />
      {showRemote && (
        <Image
          source={{ uri: uri! }}
          style={[styles.remoteImage, { opacity: remoteReady ? 1 : 0 }]}
          resizeMode="cover"
          fadeDuration={120}
          onLoad={() => setRemoteReady(true)}
          onError={() => setRemoteFailed(true)}
        />
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
