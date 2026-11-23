import type { ComponentRef } from "react";
import { Platform, type View } from "react-native";
import { captureRef, releaseCapture } from "react-native-view-shot";

export async function saveRoomCapture(scene: ComponentRef<typeof View>, save: (uri: string) => Promise<unknown>): Promise<void> {
  const uri = await captureRef(scene, {
    width: 720,
    height: 900,
    format: "png",
    result: Platform.OS === "web" ? "data-uri" : "tmpfile",
  });
  try {
    await save(uri);
  } finally {
    if (Platform.OS !== "web") releaseCapture(uri);
  }
}
