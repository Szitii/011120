type PlaybackCacheEntry = {
  readonly name: string;
  readonly exists: boolean;
  info(): { exists: boolean; size?: number | null };
  delete(): void;
};

// Matches the files created by makeIdempotencyKey("voice"), not the recorder or picker files.
const playbackFileName = /^voice-[0-9a-z]+-[0-9a-z]{0,10}\.(wav|mp3|m4a|aac|ogg)$/;
const activeFiles = new Set<string>();

export function retainPlaybackCacheFile(name: string): () => void {
  activeFiles.add(name);
  return () => { activeFiles.delete(name); };
}

export function playbackCacheBytes(entries: readonly PlaybackCacheEntry[]): number | undefined {
  try {
    let bytes = 0;
    for (const entry of entries) {
      if (!playbackFileName.test(entry.name)) continue;
      const info = entry.info();
      if (!info.exists) continue;
      if (typeof info.size !== "number" || !Number.isSafeInteger(info.size) || info.size < 0) return undefined;
      bytes += info.size;
      if (!Number.isSafeInteger(bytes)) return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

export function clearPlaybackCache(entries: readonly PlaybackCacheEntry[]): { failed: boolean; inUse: boolean } {
  let failed = false;
  let inUse = false;
  for (const entry of entries) {
    if (!playbackFileName.test(entry.name)) continue;
    if (activeFiles.has(entry.name)) {
      inUse = true;
      continue;
    }
    try {
      if (entry.exists) entry.delete();
    } catch {
      failed = true;
    }
  }
  return { failed, inUse };
}
