import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { DiarySettings } from "../../../contracts/chat.ts";
import { ApiProblemError, safeClientMessage } from "../adapters/real-api";
import { CommunityButton, communityStyles as s } from "../community/components";
import type { DiaryClient } from "./client";

const options = [["OFF", "不写"], ["RARE", "偶尔"], ["DAILY", "每天"], ["OFTEN", "常写"]] as const;

export function DiaryFrequency({ client, companionId }: { client: DiaryClient; companionId: string }) {
  const [settings, setSettings] = useState<DiarySettings>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const session = useRef(0);

  async function update(frequency?: DiarySettings["frequency"]) {
    if (pending.current) return;
    const scope = session.current;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const latest = frequency && settings
        ? await client.saveSettings(companionId, { frequency, revision: settings.revision })
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

  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.author}>日记频率</Text>
    <Text style={s.meta}>打开日记本时，TA 才会看看有没有新的事可写。</Text>
    {message !== "" && <Text accessibilityLiveRegion="polite" style={s.meta}>{message}</Text>}
    {settings ? <View style={[s.row, { flexWrap: "wrap" }]}>
      {options.map(([value, label]) => <CommunityButton key={value} label={label}
        selected={settings.frequency === value} disabled={busy || settings.frequency === value}
        onPress={() => void update(value)} />)}
    </View> : busy ? <ActivityIndicator accessibilityLabel="正在读取日记设置" />
      : <CommunityButton label="重新加载" onPress={() => void update()} />}
  </View>;
}
