import { Text, View } from "react-native";
import { CommunityButton, useCommunityStyles } from "../community/components";
import type { VoiceInfo } from "../../../contracts/chat";
import type { ChatClient } from "./client";
import { useVoicePlayback } from "./useVoicePlayback";

export function VoicePicker({ sample, voices, selected, onSelect, disabled }: {
  sample?: ChatClient["voiceSample"];
  voices: VoiceInfo[];
  selected?: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  const s = useCommunityStyles();
  const { playback, toggle } = useVoicePlayback();
  return <View style={s.card}>
    <Text style={s.author}>家机声音</Text>
    <Text style={s.meta}>选一个声音，TA 有时会发带文字稿的 AI 语音。</Text>
    <CommunityButton label="只打字" selected={selected == null} disabled={disabled} onPress={() => onSelect(null)} />
    {voices.map(voice => {
      const status = playback?.id === voice.id ? playback.status : undefined;
      const label = status === "loading" ? "取消试听" : status === "playing" ? "停止试听" : "试听";
      return <View key={voice.id}>
        <View style={s.row}>
          <CommunityButton label={voice.name} selected={voice.id === selected} disabled={disabled} onPress={() => onSelect(voice.id)} />
          {sample && <CommunityButton label={`${label} · ${voice.name}`} disabled={disabled} onPress={() => void toggle(voice.id, () => sample(voice.id))} />}
        </View>
        {!!voice.description && <Text style={s.meta}>{voice.description}</Text>}
        {(status === "error" || status === "expired") && <Text accessibilityRole="alert" style={s.meta}>暂时试听不了，稍后可以再试。</Text>}
      </View>;
    })}
  </View>;
}
