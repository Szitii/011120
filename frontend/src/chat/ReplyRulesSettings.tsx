import { useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { ReplyRule } from "../../../contracts/chat";
import { CommunityButton } from "../community/components";
import { useSkin, useThemedStyles } from "../theme/SkinProvider";
import { RADIUS } from "../theme/layoutTokens";
import type { UiPalette } from "../theme/skinTokens";

const limit = 10;
const maxLength = 200;

export function replyRuleError(rule: ReplyRule): string | undefined {
  const flags = rule.flags ?? "g";
  if (!rule.pattern || Array.from(rule.pattern).length > maxLength) return "表达式应为 1–200 字。";
  if (!/^[gimsu]*$/.test(flags) || new Set(flags).size !== flags.length) return "标记只支持 g、i、m、s、u，各用一次。";
  if (Array.from(rule.replacement ?? "").length > maxLength) return "替换内容最多 200 字。";
  if (/\$[`']/.test(rule.replacement ?? "")) return "替换内容不能引用整段匹配前或匹配后的文字。";
  try { new RegExp(rule.pattern, flags); } catch { return "正则表达式格式不正确。"; }
}

export function ReplyRulesSettings({ rules, disabled, onChange }: {
  rules: ReplyRule[];
  disabled: boolean;
  onChange: (rules: ReplyRule[]) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { ui } = useSkin();
  const [expanded, setExpanded] = useState(false);
  const serial = useRef(0);
  const keys = useRef<number[]>([]);
  if (keys.current.length !== rules.length) keys.current = rules.map(() => ++serial.current);

  function move(index: number, direction: -1 | 1) {
    const next = [...rules];
    const other = index + direction;
    [next[index], next[other]] = [next[other], next[index]];
    [keys.current[index], keys.current[other]] = [keys.current[other], keys.current[index]];
    onChange(next);
  }

  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} style={styles.heading}
        onPress={() => setExpanded(!expanded)}>
        <Text style={styles.label}>正则替换</Text>
        <Text style={styles.meta}>{expanded ? "收起" : "高级设置"}</Text>
      </Pressable>
      {expanded && <>
        <Text style={styles.meta}>规则按顺序处理家机的聊天回复。替换内容留空会移除匹配文字。修改后请保存聊天设置。</Text>
        {rules.map((rule, index) => {
          const error = replyRuleError(rule);
          const update = (patch: Partial<ReplyRule>) => onChange(rules.map((item, i) => i === index ? { ...item, ...patch } : item));
          return <View key={keys.current[index]} style={styles.rule}>
            <View style={styles.heading}>
              <Text style={styles.label}>规则 {index + 1}</Text>
              <Switch disabled={disabled} accessibilityLabel={`启用规则 ${index + 1}`}
                value={rule.enabled !== false} onValueChange={enabled => update({ enabled })} trackColor={{ true: ui.accent }} />
            </View>
            <TextInput accessibilityLabel={`规则 ${index + 1} 表达式`} placeholder="表达式" placeholderTextColor={ui.muted}
              style={styles.input} editable={!disabled} autoCorrect={false} autoCapitalize="none" value={rule.pattern}
              onChangeText={pattern => update({ pattern })} />
            <TextInput accessibilityLabel={`规则 ${index + 1} 标记`} placeholder="标记，例如 g" placeholderTextColor={ui.muted}
              style={styles.input} editable={!disabled} autoCorrect={false} autoCapitalize="none" value={rule.flags ?? "g"}
              onChangeText={flags => update({ flags })} />
            <TextInput accessibilityLabel={`规则 ${index + 1} 替换内容`} placeholder="替换内容" placeholderTextColor={ui.muted}
              style={styles.input} editable={!disabled} autoCorrect={false} autoCapitalize="none" value={rule.replacement ?? ""}
              onChangeText={replacement => update({ replacement })} />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <View style={styles.actions}>
              <CommunityButton label="上移" disabled={disabled || index === 0} onPress={() => move(index, -1)} />
              <CommunityButton label="下移" disabled={disabled || index === rules.length - 1} onPress={() => move(index, 1)} />
              <CommunityButton label="移除" disabled={disabled} onPress={() => {
                keys.current = keys.current.filter((_, i) => index !== i);
                onChange(rules.filter((_, i) => index !== i));
              }} />
            </View>
          </View>;
        })}
        <CommunityButton label="新增规则" disabled={disabled || rules.length >= limit}
          onPress={() => {
            keys.current.push(++serial.current);
            onChange([...rules, { pattern: "", flags: "g", replacement: "", enabled: true }]);
          }} />
      </>}
    </View>
  );
}

const createStyles = (ui: UiPalette) => StyleSheet.create({
  card: { padding: 14, gap: 8, borderWidth: 1, borderColor: ui.line, borderRadius: RADIUS.bubble, backgroundColor: ui.white },
  heading: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rule: { gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: ui.line, paddingTop: 6 },
  label: { fontSize: 15, color: ui.ink, fontWeight: "600" },
  meta: { fontSize: 13, color: ui.muted },
  input: { color: ui.ink, borderRadius: RADIUS.bubbleTail, borderWidth: 1, borderColor: ui.line, minHeight: 44, padding: 8 },
  error: { color: ui.danger, fontSize: 13 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
