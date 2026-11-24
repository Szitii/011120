import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  getRecordingPermissionsAsync, RecordingPresets, requestRecordingPermissionsAsync,
  setAudioModeAsync, useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton, useCommunityStyles } from "../community/components";
import { useAppIsActive } from "../state/useAppIsActive";
import type { ChatVoiceInput } from "../../../contracts/chat";
import { makeIdempotencyKey } from "./client";

const options = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 32000, sampleRate: 16000 };
const maxDuration = 60_000;

function deleteRecording(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch { /* The OS can reclaim its cache. */ }
}

function voiceError(error: unknown): { text: string; retry: boolean } {
  if (error instanceof ApiProblemError) {
    if (error.code === "VOICE_NOT_UNDERSTOOD") return { text: "没听清，请再说一次。", retry: false };
    if (error.code === "VOICE_LIMIT") return { text: "今天的语音额度用完了，请改用打字。", retry: false };
    if (error.code === "VOICE_UNAVAILABLE") return { text: "语音转文字暂不可用，请稍后再试或打字。", retry: true };
    return { text: safeClientMessage(error).title, retry: error.status >= 500 };
  }
  return { text: "语音未发送，可以重试。", retry: true };
}

export function VoiceComposer({ disabled, onRecord, onChange, onSend }: {
  disabled: boolean;
  onRecord: () => void;
  onChange: (busy: boolean) => void;
  onSend: (input: ChatVoiceInput, key: string) => Promise<void>;
}) {
  const s = useCommunityStyles();
  const recorder = useAudioRecorder(options);
  const appActive = useAppIsActive();
  const [phase, setPhase] = useState<"idle" | "preparing" | "recording" | "sending">("idle");
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState<{ input: ChatVoiceInput; key: string }>();
  const alive = useRef(true);
  const held = useRef(false);
  const session = useRef(0);
  const started = useRef<number | null>(null);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBusy = useRef(onChange);
  onBusy.current = onChange;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      held.current = false;
      session.current++;
      clearTimeout(timer.current);
      let uri: string | null = null;
      try {
        uri = recorder.uri;
        if (recorder.isRecording) void recorder.stop().catch(() => undefined).finally(() => deleteRecording(uri));
        else deleteRecording(uri);
      } catch { deleteRecording(uri); }
      if (busy.current) void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      onBusy.current(false);
    };
  }, [recorder]);

  function idle() {
    busy.current = false;
    if (alive.current) setPhase("idle");
    onBusy.current(false);
  }

  async function send(input: ChatVoiceInput, key: string) {
    if (!alive.current) return;
    setPhase("sending");
    setNotice("");
    try {
      await onSend(input, key);
      if (alive.current) setFailed(undefined);
    } catch (error) {
      if (alive.current) {
        const failure = voiceError(error);
        setNotice(failure.text);
        setFailed(failure.retry ? { input, key } : undefined);
      }
    } finally { idle(); }
  }

  async function finish(discard = false) {
    held.current = false;
    if (started.current === null) return;
    const version = session.current;
    const elapsed = Date.now() - started.current;
    started.current = null;
    clearTimeout(timer.current);
    let uri: string | null = null;
    let clip: ChatVoiceInput | undefined;
    if (!discard && alive.current) setPhase("sending");
    try {
      const measured = recorder.getStatus().durationMillis;
      await recorder.stop();
      uri = recorder.uri;
      if (discard || !alive.current) return;
      if (!uri || elapsed < 350) {
        setNotice("按住久一点，再松开发送。");
        return;
      }
      const file = new File(uri);
      if (!file.size || file.size > 700_000) {
        setNotice("录音文件异常或太大，请重新录制。");
        return;
      }
      clip = { audio: await file.base64(), mime: "audio/mp4", durationMs: Math.max(1, Math.min(maxDuration, Math.round(measured || elapsed))) };
    } catch {
      if (alive.current && !discard) setNotice("录音未保存，请重新录制。");
    } finally {
      deleteRecording(uri);
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      if (!clip) idle();
    }
    if (clip && version === session.current) await send(clip, makeIdempotencyKey("chat-voice"));
    else if (clip) idle();
  }

  useEffect(() => {
    if (!appActive) {
      session.current++;
      void finish(true);
    }
  }, [appActive]);

  async function begin() {
    if (!appActive || disabled || busy.current) return;
    held.current = true;
    busy.current = true;
    const version = ++session.current;
    onBusy.current(true);
    setNotice("");
    setFailed(undefined);
    setPhase("preparing");
    try {
      let permission = await getRecordingPermissionsAsync();
      if (!held.current || version !== session.current) return;
      if (!permission.granted) {
        permission = await requestRecordingPermissionsAsync();
        if (version === session.current) setNotice(permission.granted ? "麦克风已开启，请重新按住说话。" : "请允许麦克风权限，或改用打字。");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
      if (!held.current || version !== session.current) return;
      onRecord();
      await recorder.prepareToRecordAsync();
      if (!held.current || version !== session.current) {
        const uri = recorder.uri;
        await recorder.stop().catch(() => undefined);
        deleteRecording(uri);
        return;
      }
      recorder.record();
      started.current = Date.now();
      setPhase("recording");
      timer.current = setTimeout(() => void finish(), maxDuration);
    } catch {
      if (alive.current) setNotice("暂时无法录音，请稍后再试。");
    } finally {
      if (started.current === null) {
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        idle();
      }
    }
  }

  return <View style={s.card}>
    <Pressable accessibilityRole="button" accessibilityLabel="按住说话，松开发送"
      disabled={phase === "sending" || (disabled && phase === "idle")}
      onPressIn={() => void begin()} onPressOut={() => void finish()} style={s.row}>
      <Text style={s.author}>{phase === "recording" ? "录音中 · 松开发送" : phase === "preparing" ? "正在准备录音…" : phase === "sending" ? "正在转写并发送…" : "按住说话"}</Text>
    </Pressable>
    {!!notice && <Text accessibilityRole="alert" style={s.meta}>{notice}</Text>}
    {failed && <CommunityButton label="重发语音" disabled={disabled || phase !== "idle"} onPress={() => {
      if (busy.current) return;
      busy.current = true;
      onBusy.current(true);
      void send(failed.input, failed.key);
    }} />}
  </View>;
}
