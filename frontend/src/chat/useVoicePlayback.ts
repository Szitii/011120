import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { ApiProblemError } from "../adapters/real-api";
import { useAppIsActive } from "../state/useAppIsActive";
import { makeIdempotencyKey, type AudioClip } from "./client";
import { retainPlaybackCacheFile } from "./playback-cache";

type Source = { uri: string; dispose: () => void };

function makeSource(audio: AudioClip): Source {
  if (Platform.OS === "web") {
    const uri = URL.createObjectURL(new Blob([audio.bytes], { type: audio.mime }));
    return { uri, dispose: () => URL.revokeObjectURL(uri) };
  }
  const ext = ({ "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg" })[audio.mime];
  const name = `${makeIdempotencyKey("voice")}.${ext}`;
  const file = new File(Paths.cache, name);
  const releaseCacheFile = retainPlaybackCacheFile(name);
  const dispose = () => {
    try { if (file.exists) file.delete(); } catch { /* The OS can reclaim its cache. */ }
    finally { releaseCacheFile(); }
  };
  try {
    file.create();
    file.write(new Uint8Array(audio.bytes));
  } catch (error) {
    dispose();
    throw error;
  }
  return { uri: file.uri, dispose };
}

type Playback = { id: string; status: "loading" | "playing" | "error" | "expired" };

export function useVoicePlayback() {
  const player = useAudioPlayer();
  const appActive = useAppIsActive();
  const [playback, setPlayback] = useState<Playback>();
  const source = useRef<Source | undefined>(undefined);
  const activeTrack = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const playing = useRef(false);

  const release = useCallback(() => {
    request.current++;
    playing.current = false;
    activeTrack.current = undefined;
    const currentSource = source.current;
    source.current = undefined;
    try {
      if (currentSource) {
        player.pause();
        player.replace(null);
      }
    } catch { /* The player may already have been released on unmount. */ }
    finally { currentSource?.dispose(); }
  }, [player]);

  const stop = useCallback(() => {
    release();
    setPlayback(undefined);
  }, [release]);

  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", status => {
      if (!playing.current || !activeTrack.current) return;
      if (status.error) {
        const id = activeTrack.current;
        release();
        setPlayback({ id, status: "error" });
      } else if (status.didJustFinish) stop();
    });
    return () => {
      sub.remove();
      release();
    };
  }, [player, release, stop]);

  useEffect(() => {
    if (!appActive) stop();
  }, [appActive, stop]);

  async function toggle(id: string, load: () => Promise<AudioClip>) {
    if (!appActive) return;
    if (activeTrack.current === id) {
      stop();
      return;
    }
    release();
    activeTrack.current = id;
    const version = request.current;
    setPlayback({ id, status: "loading" });
    try {
      const audio = await load();
      if (version !== request.current) return;
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
      if (version !== request.current) return;
      source.current = makeSource(audio);
      player.replace(source.current.uri);
      playing.current = true;
      setPlayback({ id, status: "playing" });
      player.play();
    } catch (error) {
      if (version !== request.current) return;
      release();
      setPlayback({ id, status: error instanceof ApiProblemError && error.status === 404 ? "expired" : "error" });
    }
  }

  return { playback, toggle, stop };
}
