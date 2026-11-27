import assert from "node:assert/strict";
import test from "node:test";
import { clearPlaybackCache, playbackCacheBytes, retainPlaybackCacheFile } from "../src/chat/playback-cache.ts";

function entry(name: string, size: number | undefined, options: { missing?: boolean; failDelete?: boolean } = {}) {
  let exists = !options.missing;
  return {
    name,
    get exists() { return exists; },
    info() { return { exists, size }; },
    delete() {
      if (options.failDelete) throw new Error("busy");
      exists = false;
    },
  };
}

test("size covers only generated playback files; missing sizes stay unknown", () => {
  const files = [
    entry("voice-miz44k-abc12.mp3", 1024),
    entry("voice-miz44l-def34.m4a", 14),
    entry("voice-miz44m-ghi56.aac", undefined, { missing: true }),
    entry("draft-photo.jpg", 5000),
    entry("recording-miz44n.m4a", 8000),
  ];
  assert.equal(playbackCacheBytes(files), 1038);
  assert.equal(playbackCacheBytes([...files, entry("voice-miz44o-jkl78.ogg", undefined)]), undefined);
});

test("cleanup leaves active playback and unrelated cache files untouched", () => {
  const active = entry("voice-miz441-current.mp3", 100);
  const stale = entry("voice-miz442-stale.wav", 10);
  const photo = entry("draft-photo.jpg", 5);
  const recording = entry("voice-recording-jkl12345678.m4a", 200);
  const files = [active, stale, photo, recording];
  const release = retainPlaybackCacheFile(active.name);
  try {
    assert.deepEqual(clearPlaybackCache(files), { failed: false, inUse: true });
    assert.equal(active.exists, true);
    assert.equal(stale.exists, false);
    assert.equal(photo.exists, true);
    assert.equal(recording.exists, true);
    assert.equal(playbackCacheBytes(files), 100);
  } finally {
    release();
  }
  assert.deepEqual(clearPlaybackCache(files), { failed: false, inUse: false });
  assert.equal(playbackCacheBytes(files), 0);
});

test("one delete failure is reported and the other playback files can still be cleared", () => {
  const busy = entry("voice-miz443-busy.mp3", 120, { failDelete: true });
  const other = entry("voice-miz444-other.ogg", 80);
  const files = [busy, other];
  assert.deepEqual(clearPlaybackCache(files), { failed: true, inUse: false });
  assert.equal(playbackCacheBytes(files), 120);
  assert.deepEqual(clearPlaybackCache([other]), { failed: false, inUse: false });
});
