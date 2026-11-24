import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Switch, Text, View } from "react-native";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton, useCommunityStyles } from "../community/components";
import { useSkin } from "../theme/SkinProvider";
import type { DiaryClient, DiaryPreferences } from "./client";

const options = [["OFF", "不写"], ["RARE", "偶尔"], ["DAILY", "每天"], ["OFTEN", "常写"]] as const;

export function DiaryFrequency({ client, companionId }: { client: DiaryClient; companionId: string }) {
  const s = useCommunityStyles();
  const { skin } = useSkin();
  const [settings, setSettings] = useState<DiaryPreferences>();
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const session = useRef(0);

  async function update(change?: Partial<Pick<DiaryPreferences, "frequency" | "autoWrite">>) {
    if (pending.current || (change && !settings)) return;
    const scope = session.current;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const latest = change && settings
        ? await client.saveSettings(companionId, { frequency: settings.frequency, revision: settings.revision, ...change })
        : await client.getSettings(companionId);
      if (scope === session.current) setSettings(latest);
    } catch (error) {
      if (scope !== session.current) return;
      if (error instanceof ApiProblemError && error.status === 409) {
        setSettings(undefined);
        setMessage("日记设置已在别处更新，请重新选择。");
        try {
          const latest = await client.getSettings(companionId);
          if (scope === session.current) setSettings(latest);
        } catch (readError) {
          if (scope === session.current) setMessage(safeClientMessage(readError).title);
        }
      } else {
        setMessage(safeClientMessage(error).title);
      }
    } finally {
      if (scope === session.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    void update();
    return () => {
      session.current++;
      pending.current = false;
    };
  }, [client, companionId]);

  const autoWriteSupported = typeof settings?.autoWrite === "boolean";
  const autoWriteEnabled = settings?.autoWrite === true;
  const noDiary = settings?.frequency === "OFF";
  const description = noDiary ? "当前已关闭日记写作。"
    : autoWriteEnabled ? "到期且有新内容时，TA 也能在后台写日记。"
    : "打开日记本时，TA 才会看看有没有新的事可写。";

  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.author}>日记频率</Text>
    <Text style={s.meta}>{description}</Text>
    {message !== "" && <Text accessibilityLiveRegion="polite" style={s.meta}>{message}</Text>}
    {settings ? <>
      <View style={[s.row, { flexWrap: "wrap" }]}>
        {options.map(([value, label]) => <CommunityButton key={value} label={label}
          selected={settings.frequency === value} disabled={busy || confirming || settings.frequency === value}
          onPress={() => void update({ frequency: value })} />)}
      </View>
      {autoWriteSupported && <>
        <View style={[s.row, { justifyContent: "space-between", alignItems: "center" }]}>
          <Text style={s.author}>不打开也写日记</Text>
          <Switch accessibilityLabel="不打开也写日记" value={autoWriteEnabled}
            trackColor={{ false: skin.colors.border, true: skin.colors.accent }}
            disabled={busy || confirming || (noDiary && !autoWriteEnabled)}
            onValueChange={value => {
              if (value) setConfirming(true);
              else void update({ autoWrite: false });
            }} />
        </View>
        {confirming && <>
          <Text style={s.body}>后台写日记也会用到额度。平台托管使用平台额度或积分，自带 Key 使用服务商额度，自建家机使用你配置的服务。</Text>
          <View style={s.row}>
            <CommunityButton label="取消" onPress={() => setConfirming(false)} />
            <CommunityButton label="确认开启" primary onPress={() => {
              setConfirming(false);
              void update({ autoWrite: true });
            }} />
          </View>
        </>}
      </>}
    </> : busy ? <ActivityIndicator accessibilityLabel="正在读取日记设置" />
      : <CommunityButton label="重新加载" onPress={() => void update()} />}
  </View>;
}
