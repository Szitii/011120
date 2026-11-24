import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { VoiceInfo } from "../../../contracts/chat";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import type { UiPalette } from "../theme/skinTokens";
import type { ChatClient } from "./client";
import { useVoicePlayback } from "./useVoicePlayback";

export function VoicePicker({ sample, voices, selected, onSelect, disabled }: {
  sample?: ChatClient["voiceSample"];
  voices: VoiceInfo[];
  selected?: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  const { ui } = useSkin();
  const s = useThemedStyles(createStyles);
  const { playback, toggle, stop } = useVoicePlayback();
  const textOnly = selected == null;

  function handleToggleTextOnly(nextTextOnly: boolean) {
    if (disabled) return;
    if (nextTextOnly) {
      stop();
      onSelect(null);
    } else if (voices.length > 0) {
      const first = voices[0];
      onSelect(first.id);
      if (sample) void toggle(first.id, () => sample(first.id));
    }
  }

  function handleVoicePress(voice: VoiceInfo) {
    if (disabled) return;
    if (selected !== voice.id) {
      onSelect(voice.id);
    }
    if (sample) {
      void toggle(voice.id, () => sample(voice.id));
    }
  }

  return (
    <View style={s.card}>
      <View style={s.header}>
        <Text style={s.title}>家机声音</Text>
        <Text style={s.subtitle}>轻点即可选中并试听</Text>
      </View>

      <View style={s.switchRow}>
        <Text style={s.switchLabel}>只打字</Text>
        <Switch
          accessibilityLabel="只打字"
          value={textOnly}
          disabled={disabled}
          onValueChange={handleToggleTextOnly}
          trackColor={{ false: ui.line, true: ui.accent }}
          thumbColor={ui.white}
        />
      </View>

      {!textOnly && (
        <View style={s.grid}>
          {voices.map(voice => {
            const isSelected = voice.id === selected;
            const status = playback?.id === voice.id ? playback.status : undefined;
            const isPlaying = status === "playing" || status === "loading";
            return (
              <Pressable
                key={voice.id}
                accessibilityRole="button"
                accessibilityLabel={`${voice.name}${voice.description ? `，${voice.description}` : ""}`}
                accessibilityState={{ selected: isSelected }}
                disabled={disabled}
                onPress={() => handleVoicePress(voice)}
                style={({ pressed }) => [
                  s.voiceCard,
                  isSelected && s.voiceCardSelected,
                  pressed && !disabled && { opacity: 0.85 },
                ]}
              >
                <View style={s.voiceMain}>
                  <Text style={[s.voiceName, isSelected && s.voiceNameSelected]} numberOfLines={1}>
                    {voice.name}
                  </Text>
                  {!!voice.description && (
                    <Text style={s.voiceDesc} numberOfLines={1}>
                      {voice.description}
                    </Text>
                  )}
                </View>
                {isSelected && (
                  <Ionicons
                    name={isPlaying ? "stop-circle-outline" : "volume-medium-outline"}
                    size={19}
                    color={ui.accentInk}
                  />
                )}
              </Pressable>
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
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  voiceCard: {
    width: "48%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 11,
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
  voiceMain: { flex: 1, gap: 2 },
  voiceName: { fontSize: 14, fontWeight: "600", color: ui.ink },
  voiceNameSelected: { color: ui.accentInk },
  voiceDesc: { fontSize: 11.5, color: ui.muted },
  errorText: { fontSize: 12, color: ui.danger },
});
