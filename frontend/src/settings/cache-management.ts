import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { clearPlaybackCache, playbackCacheBytes } from "../chat/playback-cache";

function cacheFiles(): File[] {
  return Paths.cache.list().filter((entry): entry is File => entry instanceof File);
}

export function readPlaybackCacheBytes(): number | undefined {
  try {
    return playbackCacheBytes(cacheFiles());
  } catch {
    return undefined;
  }
}

export async function clearAppCache(): Promise<{ failed: boolean; inUse: boolean }> {
  const images = await Promise.allSettled([
    Image.clearDiskCache(),
    Image.clearMemoryCache(),
  ]);
  const imagesFailed = images.some(result => result.status === "rejected" || !result.value);
  try {
    const playback = clearPlaybackCache(cacheFiles());
    return { failed: imagesFailed || playback.failed, inUse: playback.inUse };
  } catch {
    return { failed: true, inUse: false };
  }
}

export function formatCacheBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
