import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { VoiceInfo } from "../../../contracts/chat";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";
import { useVoicePlayback } from "./useVoicePlayback";

export function VoicePicker({ sample, voices, saved, selected, onSelect, disabled }: {
  sample?: ChatClient["voiceSample"];
  voices: VoiceInfo[];
  saved?: string | null;
  selected?: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const { playback, toggle, stop } = useVoicePlayback();
  const textOnly = selected == null;
  const savedVoice = voices.find(voice => voice.id === saved);
  const savedLabel = saved == null ? "只打字" : savedVoice?.name ?? "已选音色暂不可用";

  function handleToggleTextOnly(nextTextOnly: boolean) {
    if (disabled) return;
    if (nextTextOnly) {
      stop();
      onSelect(null);
    } else if (voices.length > 0) {
      onSelect(savedVoice?.id ?? voices[0].id);
    }
  }

  return (
    <View style={s.card}>
      <View style={s.header}>
        <Text style={s.title}>家机声音</Text>
        <Text style={s.subtitle}>当前已保存 · {savedLabel}</Text>
      </View>

      <View style={s.switchRow}>
        <Text style={s.switchLabel}>只打字</Text>
        <Switch
          accessibilityLabel="只打字"
          value={textOnly}
          disabled={disabled || (textOnly && voices.length === 0)}
          onValueChange={handleToggleTextOnly}
          trackColor={{ false: ui.line, true: ui.accent }}
          thumbColor={ui.white}
        />
      </View>

      {voices.length > 0 && (
        <View style={s.grid}>
          {voices.map(voice => {
            const isSelected = voice.id === selected;
            const status = playback?.id === voice.id ? playback.status : undefined;
            const isPlaying = status === "playing" || status === "loading";
            return (
              <View key={voice.id} style={[s.voiceCard, isSelected && s.voiceCardSelected]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`选择音色 ${voice.name}`}
                  accessibilityHint={voice.description}
                  accessibilityState={{ selected: isSelected }}
                  disabled={disabled}
                  onPress={() => onSelect(voice.id)}
                  style={s.voiceMain}
                >
                  <Text style={[s.voiceName, isSelected && s.voiceNameSelected]} numberOfLines={1}>
                    {voice.name}
                  </Text>
                  {!!voice.description && (
                    <Text style={s.voiceDesc} numberOfLines={1}>
                      {voice.description}
                    </Text>
                  )}
                </Pressable>
                {sample && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${isPlaying ? "停止试听" : "试听"} ${voice.name}`}
                    disabled={disabled}
                    onPress={() => void toggle(voice.id, () => sample(voice.id))}
                    style={s.preview}
                  >
                    <Ionicons
                      name={isPlaying ? "stop-circle-outline" : "volume-medium-outline"}
                      size={17}
                      color={ui.accentInk}
                    />
                    <Text style={s.previewLabel}>{isPlaying ? "停止" : "试听"}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      )}

      {playback && (playback.status === "error" || playback.status === "expired") && (
        <Text accessibilityRole="alert" style={s.errorText}>
          暂时试听不了，稍后可以再试。
        </Text>
      )}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.white,
    padding: 16,
    gap: 12,
  },
  header: { gap: 2 },
  title: { fontSize: 15.5, fontWeight: "700", color: ui.ink },
  subtitle: { fontSize: 12.5, color: ui.muted },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: ui.background[0],
  },
  switchLabel: { fontSize: 14, fontWeight: "600", color: ui.ink },
  grid: { gap: 8 },
  voiceCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: ui.line,
    backgroundColor: ui.background[0],
    gap: 6,
  },
  voiceCardSelected: {
    borderColor: ui.accent,
    borderWidth: 1.5,
    backgroundColor: ui.accentWash,
  },
  voiceMain: { flex: 1, minHeight: 48, justifyContent: "center", paddingVertical: 6, gap: 2 },
  preview: { minHeight: 44, paddingHorizontal: 6, alignItems: "center", flexDirection: "row", gap: 4 },
  previewLabel: { fontSize: 12, color: ui.accentInk },
  voiceName: { fontSize: 14, fontWeight: "600", color: ui.ink },
  voiceNameSelected: { color: ui.accentInk },
  voiceDesc: { fontSize: 11.5, color: ui.muted },
  errorText: { fontSize: 12, color: ui.danger },
});
